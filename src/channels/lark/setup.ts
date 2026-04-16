import { select, input, password } from "@inquirer/prompts";
import qrcode from "qrcode-terminal";
import { getDomainBaseUrl } from "./client.js";
import type { LarkChannelConfig } from "../../config/schema.js";
import { getLogger } from "../../logger.js";

const logger = getLogger("lark-setup");

interface AppRegistrationResult {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  ownerOpenId: string;
}

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";

async function httpPostForm(
  url: string,
  params: Record<string, string>
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return res.json();
}

async function httpPostJson(
  url: string,
  body: Record<string, unknown>
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * QR code bot creation flow using Feishu App Registration API.
 */
async function qrCodeFlow(): Promise<AppRegistrationResult> {
  const registrationUrl = `${FEISHU_ACCOUNTS_URL}/oauth/v1/app/registration`;

  // Step 1: init - returns nonce and supported_auth_methods
  const initRes = await httpPostForm(registrationUrl, { action: "init" });

  if (!initRes?.nonce) {
    throw new Error(
      `Failed to init app registration: ${JSON.stringify(initRes)}`
    );
  }

  // Step 2: begin - returns qrcode_url and device_code
  const beginRes = await httpPostForm(registrationUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  if (!beginRes?.verification_uri_complete || !beginRes?.device_code) {
    throw new Error(
      `Failed to begin app registration: ${JSON.stringify(beginRes)}`
    );
  }

  const deviceCode = beginRes.device_code;
  const qrUrl = beginRes.verification_uri_complete;

  console.log("\n请使用飞书扫描以下二维码创建机器人：");
  console.log("Scan with Feishu to create bot:\n");
  qrcode.generate(qrUrl, { small: true });
  console.log(`\nQR URL: ${qrUrl}\n`);

  console.log("等待扫码... Waiting for scan...");

  const maxAttempts = 120;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    const pollRes = await httpPostForm(registrationUrl, {
      action: "poll",
      device_code: deviceCode,
    });

    if (pollRes?.status === "success" || pollRes?.client_id) {
      const tenantBrand = pollRes.user_info?.tenant_brand;
      const domain: "feishu" | "lark" =
        tenantBrand === "lark" ? "lark" : "feishu";

      console.log("\n✓ 机器人配置成功! Bot configured!");
      return {
        appId: pollRes.client_id,
        appSecret: pollRes.client_secret,
        domain,
        ownerOpenId: pollRes.user_info?.open_id || "",
      };
    }

    if (pollRes?.error && pollRes.error !== "authorization_pending" && pollRes.error !== "slow_down") {
      throw new Error(`QR code flow failed: ${JSON.stringify(pollRes)}`);
    }

    process.stdout.write(".");
  }

  throw new Error("QR code flow timed out");
}

/**
 * Manual credential entry with domain auto-detection.
 */
async function manualFlow(): Promise<AppRegistrationResult> {
  const appId = await input({
    message: "Enter App ID:",
    validate: (v) => (v.trim() ? true : "App ID is required"),
  });

  const appSecret = await password({
    message: "Enter App Secret:",
    mask: "*",
    validate: (v) => (v.trim() ? true : "App Secret is required"),
  });

  // Auto-detect domain
  let domain: "feishu" | "lark" = "feishu";
  let validated = false;

  for (const d of ["feishu", "lark"] as const) {
    const baseUrl = getDomainBaseUrl(d);
    try {
      const res = await httpPostJson(
        `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        { app_id: appId.trim(), app_secret: appSecret.trim() }
      );
      if (res.code === 0 && res.tenant_access_token) {
        domain = d;
        validated = true;
        break;
      }
    } catch {
      // Try next domain
    }
  }

  if (!validated) {
    throw new Error(
      "凭证校验失败 Credentials validation failed. Check App ID and App Secret."
    );
  }

  console.log(`✓ 凭证校验成功 Credentials verified (${domain})`);

  // Auto-detect owner from app info
  let ownerOpenId = "";
  try {
    const baseUrl = getDomainBaseUrl(domain);
    const tokenRes = await httpPostJson(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: appId.trim(), app_secret: appSecret.trim() }
    );
    if (tokenRes.code === 0 && tokenRes.tenant_access_token) {
      const appRes = await fetch(
        `${baseUrl}/open-apis/application/v6/applications/${appId.trim()}?lang=zh_cn`,
        { headers: { Authorization: `Bearer ${tokenRes.tenant_access_token}` } }
      );
      const appData = await appRes.json() as any;
      if (appData.code === 0) {
        ownerOpenId = appData.data?.app?.owner?.owner_id || appData.data?.app?.creator_id || "";
        if (ownerOpenId) {
          console.log(`✓ 已自动获取 Owner: ${ownerOpenId}`);
        }
      }
    }
  } catch {
    logger.warn("failed to auto-detect owner, skipping");
  }

  return {
    appId: appId.trim(),
    appSecret: appSecret.trim(),
    domain,
    ownerOpenId,
  };
}

/**
 * Run the full Lark setup flow.
 */
export async function runLarkSetup(): Promise<LarkChannelConfig> {
  const method = await select({
    message: "选择配置方式 Select configuration method:",
    choices: [
      {
        name: "扫码创建新机器人 Scan QR code to create bot",
        value: "qr" as const,
      },
      {
        name: "手动输入 App ID / App Secret Enter manually",
        value: "manual" as const,
      },
    ],
  });

  let result: AppRegistrationResult;

  if (method === "qr") {
    result = await qrCodeFlow();
  } else {
    result = await manualFlow();
  }

  const config: LarkChannelConfig = {
    appId: result.appId,
    appSecret: result.appSecret,
    domain: result.domain,
    owners: result.ownerOpenId ? [result.ownerOpenId] : [],
    ackEmoji: "OnIt",
    streamingIntervalMs: 500,
    idleTimeoutMin: 0,
  };

  return config;
}

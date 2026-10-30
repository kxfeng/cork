import { describe, it, expect } from "vitest";
import { chatMembership } from "../src/channels/lark/client.js";

const client = (get: (req: { params: { page_token?: string } }) => Promise<unknown>) =>
  ({ im: { chatMembers: { get } } }) as never;

describe("chatMembership", () => {
  it("pages until an owner turns up", async () => {
    const pages: Record<string, unknown> = {
      "": { code: 0, data: { member_total: 150, has_more: true, page_token: "p2", items: [{ member_id: "ou_a" }] } },
      p2: { code: 0, data: { member_total: 150, has_more: false, items: [{ member_id: "ou_owner" }] } },
    };
    const got = await chatMembership(client(async (r) => pages[r.params.page_token ?? ""]), "oc_1", ["ou_owner"]);
    expect(got).toEqual({ hasAny: true, members: 150 });
  });

  it("says denied for a missing scope, whether returned or thrown", async () => {
    const returned = await chatMembership(client(async () => ({ code: 99991672, msg: "scope" })), "oc_1", []);
    const thrown = await chatMembership(
      client(async () => {
        throw Object.assign(new Error("400"), { response: { data: { code: 99991672, msg: "scope" } } });
      }),
      "oc_1",
      []
    );
    expect([returned, thrown]).toEqual(["denied", "denied"]);
  });

  it("is undefined for any other failure", async () => {
    const got = await chatMembership(
      client(async () => {
        throw new Error("timeout");
      }),
      "oc_1",
      []
    );
    expect(got).toBeUndefined();
  });
});

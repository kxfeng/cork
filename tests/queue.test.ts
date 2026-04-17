import { describe, it, expect } from "vitest";
import { ChatQueue } from "../src/dispatcher/queue.js";

// Suppress logger output in tests
import { vi } from "vitest";
vi.mock("../src/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe("ChatQueue", () => {
  it("processes tasks in FIFO order for same chat", async () => {
    const queue = new ChatQueue();
    const order: number[] = [];

    await Promise.all([
      queue.enqueue("chat1", async () => {
        await delay(50);
        order.push(1);
      }),
      queue.enqueue("chat1", async () => {
        order.push(2);
      }),
      queue.enqueue("chat1", async () => {
        order.push(3);
      }),
    ]);

    // Wait for all tasks to complete
    await delay(100);
    expect(order).toEqual([1, 2, 3]);
  });

  it("processes different chats in parallel", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    const p1 = queue.enqueue("chat1", async () => {
      events.push("chat1-start");
      await delay(100);
      events.push("chat1-end");
    });

    const p2 = queue.enqueue("chat2", async () => {
      events.push("chat2-start");
      await delay(50);
      events.push("chat2-end");
    });

    await Promise.all([p1, p2]);
    await delay(150);

    // chat2 should finish before chat1 since it's shorter and runs in parallel
    expect(events.indexOf("chat2-end")).toBeLessThan(events.indexOf("chat1-end"));
  });

  it("isolates errors between tasks in same chat", async () => {
    const queue = new ChatQueue();
    const results: string[] = [];

    await queue.enqueue("chat1", async () => {
      throw new Error("task 1 failed");
    });

    await queue.enqueue("chat1", async () => {
      results.push("task 2 ok");
    });

    await delay(50);
    expect(results).toEqual(["task 2 ok"]);
  });

  it("cleans up queue after processing", async () => {
    const queue = new ChatQueue();
    let count = 0;

    await queue.enqueue("chat1", async () => {
      count++;
    });

    await delay(50);

    // Enqueue again should work fine (queue was cleaned up)
    await queue.enqueue("chat1", async () => {
      count++;
    });

    await delay(50);
    expect(count).toBe(2);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

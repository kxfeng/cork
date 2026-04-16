import { getLogger } from "../logger.js";

const logger = getLogger("message-queue");

type Task = () => Promise<void>;

export class ChatQueue {
  private queues = new Map<string, Task[]>();
  private processing = new Set<string>();

  async enqueue(chatId: string, task: Task): Promise<void> {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, []);
    }
    this.queues.get(chatId)!.push(task);

    if (!this.processing.has(chatId)) {
      await this.processQueue(chatId);
    }
  }

  private async processQueue(chatId: string): Promise<void> {
    this.processing.add(chatId);
    const queue = this.queues.get(chatId);

    while (queue && queue.length > 0) {
      const task = queue.shift()!;
      try {
        await task();
      } catch (err) {
        logger.error("task failed in chat queue", { err, chatId });
      }
    }

    this.processing.delete(chatId);
    this.queues.delete(chatId);
  }
}

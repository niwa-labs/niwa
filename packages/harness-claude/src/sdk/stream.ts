/** The input stream of a query: the SDK reads user messages from it for as long as it lives. */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** The stream of messages into a query. */
export class MessageStream {
  readonly #queue: SDKUserMessage[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  /** Pushes a message into the stream. */
  push(message: SDKUserMessage): void {
    if (this.#closed) return;
    this.#queue.push(message);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Closes the stream: the session ends with it. */
  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Whether the stream is closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The messages, as the SDK reads them. */
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.#queue.length > 0) {
        const message = this.#queue.shift();
        if (message !== undefined) yield message;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
    }
  }
}

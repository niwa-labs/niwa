/**
 * A scripted `query` for the SDK control side: no process runs, and the test decides when a turn
 * ends and whether the program merges messages that reach it together, as the real one does.
 *
 * Every query it serves is recorded: the options it was opened with, the messages it received,
 * and the interrupts it was given.
 */

import { randomUUID } from "node:crypto";

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Query = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

/** One query the scripted `query` served. */
export interface ServedQuery {
  readonly options: Options;
  /** The texts of the user messages it received, in order. */
  readonly received: string[];
  interrupts: number;
}

export interface Scripted {
  readonly query: Query;
  readonly served: ServedQuery[];
  /** Lets the turn each blocked query holds end; with no block, turns end by themselves. */
  hold(): { release(): void };
}

/**
 * `mergeWindowMs`: messages that reach the query within this long of each other are one turn with
 * one result, as the SDK does with messages written while it reads.
 */
export function scriptedQuery(options: { mergeWindowMs?: number } = {}): Scripted {
  const served: ServedQuery[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;

  const query: Query = ({ prompt, options: sdk }) => {
    const record: ServedQuery = { options: sdk, received: [], interrupts: 0 };
    served.push(record);
    const session = sdk.resume ?? randomUUID();
    let cut: (() => void) | undefined;
    let closed = false;

    const textOf = (message: SDKUserMessage): string => {
      const content = message.message.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    };

    async function* messages(): AsyncGenerator<SDKMessage> {
      const input = prompt[Symbol.asyncIterator]();
      let named = sdk.resume !== undefined;
      let carried: Promise<IteratorResult<SDKUserMessage>> | undefined;
      for (;;) {
        const first = await (carried ?? input.next());
        carried = undefined;
        if (first.done === true || closed) return;
        record.received.push(textOf(first.value));
        if (options.mergeWindowMs !== undefined) {
          for (;;) {
            const next = input.next();
            const got = await Promise.race([
              next,
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.mergeWindowMs)),
            ]);
            if (got === undefined) {
              carried = next;
              break;
            }
            if (got.done === true) return;
            record.received.push(textOf(got.value));
          }
        }
        if (!named) {
          named = true;
          yield { type: "system", subtype: "init", session_id: session, model: sdk.model ?? "fake" } as unknown as SDKMessage;
        }
        let interrupted = false;
        if (gate !== undefined) {
          interrupted = await Promise.race([
            gate.then(() => false),
            new Promise<boolean>((resolve) => {
              cut = () => resolve(true);
            }),
          ]);
          cut = undefined;
        }
        yield (
          interrupted
            ? { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], session_id: session }
            : { type: "result", subtype: "success", is_error: false, result: "ok", structured_output: sdk.outputFormat === undefined ? undefined : "ok", session_id: session }
        ) as unknown as SDKMessage;
      }
    }

    const stream = messages();
    return {
      [Symbol.asyncIterator]: () => stream,
      interrupt: async () => {
        record.interrupts += 1;
        cut?.();
      },
      close: () => {
        closed = true;
        cut?.();
      },
    };
  };

  return {
    query,
    served,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return {
        release: () => {
          open?.();
          gate = undefined;
        },
      };
    },
  };
}

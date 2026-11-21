/**
 * A fake of the SDK's `query` for the control side of the claude-sdk kind: no process runs.
 *
 * Each query reads its user messages and answers every one with a result after a short pause;
 * the first message of a query that was not resumed is preceded by the `system/init` message that
 * names the session. An interrupt ends the turn in flight with an error result at once.
 *
 * `firstTurnMs` sets how long the first turn of a query that was not resumed takes; `Infinity`
 * makes it a turn that never ends on its own.
 *
 * `calls` are the tool calls the SDK asks `canUseTool` about in their turn (the first by default),
 * one after another, before the turn's result. A call with `cancelAfterMs` is cancelled by the SDK that long after it
 * began, as the CLI does with a control request it no longer waits for; an interrupt cancels the
 * call in flight and ends the turn at once. What `canUseTool` answered is kept, in `outcomes`.
 */

import { randomUUID } from "node:crypto";

import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The shape of the SDK's `query` that the Claude Agent SDK control side takes. */
type SdkQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown>; close(): void };

/** How long a turn takes before its result comes, unless it is interrupted. */
const TURN_MS = 20;

const USAGE: SDKResultMessage["usage"] = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  fallback_credit: null,
  output_tokens_details: { thinking_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: "",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

function init(session: string, model: string): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "fake",
    cwd: "/",
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: session,
  };
}

function result(session: string, text: string, structured: unknown, cut: boolean): SDKResultMessage {
  const common = {
    type: "result" as const,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: USAGE,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: session,
  };
  if (cut) {
    return { ...common, subtype: "error_during_execution", is_error: true, errors: ["interrupted"] };
  }
  return {
    ...common,
    subtype: "success",
    is_error: false,
    result: text,
    ...(structured === undefined ? {} : { structured_output: structured }),
  };
}

/** A tool call the fake SDK asks `canUseTool` about. */
export interface FakeCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly title?: string;
  readonly description?: string;
  readonly blockedPath?: string;
  /** The turn of the session that asks it, counted from 1. Default: the first. */
  readonly turn?: number;
  /** The SDK cancels the call this long after it began. */
  readonly cancelAfterMs?: number;
}

/** The fake `query`; every query it served is counted by `served` and closed by `close`. */
export function fakeSdkQuery(
  options: {
    firstTurnMs?: number;
    calls?: readonly FakeCall[];
    /** The names the program gives the models it is asked for by an alias: `system/init` says the name, not the alias. */
    models?: Readonly<Record<string, string>>;
  } = {},
): {
  query: SdkQuery;
  served: () => number;
  open: () => number;
  /** What `canUseTool` answered for each call, in order; `undefined` where the query had no `canUseTool`. */
  outcomes: () => ReadonlyArray<PermissionResult | undefined>;
  /** The options of every query served, in order. */
  asked: () => ReadonlyArray<Parameters<SdkQuery>[0]["options"]>;
} {
  const asked: Array<Parameters<SdkQuery>[0]["options"]> = [];
  const outcomes: Array<PermissionResult | undefined> = [];
  let served = 0;
  let open = 0;
  const query: SdkQuery = ({ prompt, options: sdk }) => {
    served += 1;
    open += 1;
    asked.push(sdk);
    const resumed = sdk.resume;
    const session = resumed ?? randomUUID();
    let cut: (() => void) | undefined;
    let closed = false;

    async function* messages(): AsyncGenerator<SDKMessage> {
      try {
        let named = resumed !== undefined;
        let turn = 0;
        for await (const _message of prompt) {
          if (closed) return;
          let turnMs = TURN_MS;
          turn += 1;
          if (!named) {
            named = true;
            turnMs = options.firstTurnMs ?? TURN_MS;
            yield init(session, sdk.model === undefined ? "fake" : (options.models?.[sdk.model] ?? sdk.model));
          }
          let cutInCalls = false;
          for (const call of (options.calls ?? []).filter((entry) => (entry.turn ?? 1) === turn)) {
            if (cutInCalls) break;
            const ended = new AbortController();
            cut = () => {
              cutInCalls = true;
              ended.abort();
            };
            const timer = call.cancelAfterMs === undefined ? undefined : setTimeout(() => ended.abort(), call.cancelAfterMs);
            outcomes.push(
              await sdk.canUseTool?.(call.tool, call.input, {
                signal: ended.signal,
                toolUseID: `tu-${outcomes.length + 1}`,
                requestId: `req-${outcomes.length + 1}`,
                ...(call.title === undefined ? {} : { title: call.title }),
                ...(call.description === undefined ? {} : { description: call.description }),
                ...(call.blockedPath === undefined ? {} : { blockedPath: call.blockedPath }),
              }) ?? undefined,
            );
            clearTimeout(timer);
            cut = undefined;
          }
          const interrupted = cutInCalls || (await new Promise<boolean>((resolve) => {
            const timer = Number.isFinite(turnMs) ? setTimeout(() => resolve(false), turnMs) : undefined;
            cut = () => {
              clearTimeout(timer);
              resolve(true);
            };
          }));
          cut = undefined;
          // A question with a schema is answered with a value that passes it.
          yield result(session, "ok", sdk.outputFormat === undefined ? undefined : "ok", interrupted);
        }
      } finally {
        open -= 1;
      }
    }

    const stream = messages();
    return {
      [Symbol.asyncIterator]: () => stream,
      interrupt: async () => {
        cut?.();
      },
      close: () => {
        closed = true;
        cut?.();
      },
    };
  };
  return { query, served: () => served, open: () => open, outcomes: () => outcomes, asked: () => asked };
}

/** The line every live Claude prompt carries: Claude Code may call its advisor, which is slow and not what a test measures. */
export const NO_ADVISOR = "Do not call the advisor tool.";

/** A prompt for a live Claude session: the text, then the line that keeps the advisor out. */
export function claudePrompt(text: string): string {
  return `${text}\n\n${NO_ADVISOR}`;
}

import { resolve } from "node:path";

import { ServerFetch } from "@opencode/server/fetch";
import { Effect } from "effect";

import {
  MAX_ACTIVE_REQUESTS,
  OPENCODE_RUNTIME_VERSION,
  PIPE_ORIGIN,
  PROXY_CLOSE_ENV,
  RESPONSE_CHUNK_BYTES,
  encodeFrame,
  readFrames,
  writeFrame,
} from "./pipe-wire.ts";
import type { PipeCommand, PipeReply } from "./pipe-wire.ts";

interface Running {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  pull(): void;
}

const send = (message: PipeReply): Promise<void> => writeFrame(process.stdout, encodeFrame(message));

/** Runs one scoped vendor server on inherited pipes, with the same Fetch requests as its HTTP API. */
async function relay(handler: (request: Request) => Promise<Response>): Promise<void> {
  const running = new Map<number, Running>();
  try {
    await send({ kind: "ready" });
    for await (const command of readFrames<PipeCommand>(process.stdin)) {
      const current = running.get(command.id);
      if (command.kind === "pull") {
        current?.pull();
      } else if (command.kind === "cancel") {
        current?.abort.abort();
      } else if (command.kind === "request") {
        if (current !== undefined) throw new Error("Duplicate OpenCode pipe request id");
        if (running.size >= MAX_ACTIVE_REQUESTS) {
          await send({ id: command.id, kind: "error", message: "Too many OpenCode pipe requests" });
          continue;
        }
        const abort = new AbortController();
        let demand = Promise.withResolvers<void>();
        abort.signal.addEventListener("abort", () => demand.resolve(), { once: true });
        const done = handle(command, handler, abort.signal, async () => {
          await demand.promise;
          demand = Promise.withResolvers<void>();
          abort.signal.throwIfAborted();
        }).catch((error: unknown) => {
          if (!abort.signal.aborted) return send({ id: command.id, kind: "error", message: String(error).slice(0, 2048) });
        }).finally(() => running.delete(command.id));
        // On a broken output pipe the host closes stdin and the scope releases all outstanding requests.
        void done.catch(() => {});
        running.set(command.id, { abort, done, pull: () => demand.resolve() });
      } else {
        throw new Error("Invalid OpenCode pipe command");
      }
    }
  } finally {
    for (const request of running.values()) request.abort.abort();
    await Promise.allSettled([...running.values()].map((request) => request.done));
  }
}

async function handle(
  command: Extract<PipeCommand, { kind: "request" }>,
  handler: (request: Request) => Promise<Response>,
  signal: AbortSignal,
  waitForRead: () => Promise<void>,
): Promise<void> {
  const url = new URL(command.path, PIPE_ORIGIN);
  if (url.origin !== PIPE_ORIGIN) throw new Error("Invalid OpenCode pipe request origin");
  const { id, method, headers, body } = command;
  const response = await handler(new Request(url, { method, headers, body, signal }));
  const reader = response.body?.getReader();
  const cancel = () => void reader?.cancel().catch(() => {});
  try {
    signal.throwIfAborted();
    signal.addEventListener("abort", cancel, { once: true });
    await send({ id, kind: "headers", status: response.status, statusText: response.statusText, headers: [...response.headers], hasBody: reader !== undefined });
    if (reader === undefined) return;

    await waitForRead();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      for (let offset = 0; offset < value.length; offset += RESPONSE_CHUNK_BYTES) {
        const chunk = value.subarray(offset, offset + RESPONSE_CHUNK_BYTES);
        await send({ id, kind: "chunk", base64: Buffer.from(chunk).toString("base64") });
        await waitForRead();
      }
    }
    await send({ id, kind: "end" });
  } finally {
    signal.removeEventListener("abort", cancel);
    if (reader !== undefined) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

const env = process.env;
const password = env.OPENCODE_PASSWORD;
const closeProxiedLoopback = env[PROXY_CLOSE_ENV] === "1" && Boolean(env.http_proxy ?? env.HTTP_PROXY);
delete env.OPENCODE_PASSWORD;
delete env.OPENCODE_SERVER_PASSWORD;
delete env[PROXY_CLOSE_ENV];
if (!password || !env.XDG_DATA_HOME) throw new Error("The boxed OpenCode worker needs a lease password and XDG_DATA_HOME");

/** nono's forwarding proxy can leave a reused plain HTTP connection waiting after a streamed reply. */
function fetchThroughNono(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
}

const truthy = (value: string | undefined): boolean => value === "1" || value?.toLowerCase() === "true";
const noClaude = truthy(env.OPENCODE_DISABLE_CLAUDE_CODE);
// Map the environment as the pinned `opencode serve` does. The official release uses the stable
// channel filename. Box admission has already validated an explicit DB path and its sidecars.
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { name: env.OPENCODE_CLIENT ?? "cli", version: OPENCODE_RUNTIME_VERSION, channel: "latest" },
    password,
    ...(closeProxiedLoopback ? { fetch: fetchThroughNono } : {}),
    simulation: truthy(env.OPENCODE_SIMULATE),
    database: { path: resolve(env.XDG_DATA_HOME!, "opencode", env.OPENCODE_DB ?? "opencode.db") },
    models: {
      url: env.OPENCODE_MODELS_URL,
      file: env.OPENCODE_MODELS_PATH,
      fetch: !truthy(env.OPENCODE_DISABLE_MODELS_FETCH),
    },
    config: {
      directory: env.OPENCODE_CONFIG_DIR,
      project: !truthy(env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG),
      claude: !(noClaude || truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)),
      file: env.OPENCODE_CONFIG,
      content: env.OPENCODE_CONFIG_CONTENT,
    },
    instructions: { claude: !(noClaude || truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT)) },
    windows: { gitbash: env.OPENCODE_GIT_BASH_PATH },
    fs: {
      filewatcher: !truthy(env.OPENCODE_FILEWATCHER_DISABLE ?? env.OPENCODE_DISABLE_FILEWATCHER),
      fff: env.OPENCODE_DISABLE_FFF === undefined ? process.platform !== "win32" : !truthy(env.OPENCODE_DISABLE_FFF),
    },
  });
  yield* Effect.tryPromise(() => relay(handler));
})));

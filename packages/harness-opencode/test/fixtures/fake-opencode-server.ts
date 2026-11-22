#!/usr/bin/env bun
/**
 * A stand-in for `opencode serve --stdio` (opencode v2): the real typed client of
 * `@opencode/client` speaks to it, so the routes, the shapes and the SSE stream are the ones the
 * generated client builds. It reads the password from `OPENCODE_PASSWORD`, serves HTTP on
 * 127.0.0.1:0, prints the one JSON announcement line `{"url": ...}` on stdout, stays up while its
 * stdin is open and exits when it closes, as the real server does.
 *
 * Everything it is given is written into its working directory, so a test reads what the control
 * side asked: `requests.log` (every request as `{method, path, body}`), `replies.log` (every
 * permission reply) and `sessions.json` (the sessions it keeps, which a later fake of the same
 * directory reads back, as the real server reads its database). Its own address goes to
 * `url.log`, one line per run, so a test can push events onto the stream through
 * `POST /control/push` (the body is the event, broadcast as it is).
 *
 * A turn plays by its prompt's content, as the real server would: the default answers "fake
 * reply"; "slow" and "hang" never end until an interrupt; "fail" fails; "die" kills the process;
 * "json" and "fenced" answer with JSON, bare and fenced; "silent" ends with no text on the stream
 * (the transcript holds "from the transcript"); "empty" leaves no answer anywhere; "permission"
 * asks leave (`permission.asked`) and waits for the reply — allowed once it answers, rejected it
 * fails; "script" plays the steps of `script.json` (`{event}` pushes an event, `{ms}` pauses; the
 * sessionID of a `session.*` event is filled in) and then completes. The version of `GET
 * /api/info` comes from `FAKE_VERSION` (default "2.3.2"): a server of another major is how a
 * version mismatch is played; `FAKE_SILENT_STREAM` holds the event stream's hello back, so a
 * start against it must give up within the call timeout; `FAKE_SILENT_BOOT` keeps the
 * announcement itself back — a child that boots but never says where it is.
 *
 * Reading fixtures: with `FAKE_DATA_DIR` set, the reading endpoints serve a data directory the
 * test wrote — `GET /api/session` (list) and `GET /api/session/:id` from `sessions.json`, and
 * `GET /api/session/:id/message` from `messages-<id>.json` — read back on every request, so what
 * a test rewrites between calls (a line finished, a session taken away) is what the next call
 * sees, as the real server reads its database. A messages file that is not JSON answers 500: a
 * session whose store cannot be read. The list honours `directory`, `parentID`, `order`, `limit`
 * and `cursor` (an offset); the message list honours `order`, `limit` and `cursor`.
 */

const password = process.env.OPENCODE_PASSWORD;
if (password === undefined || password === "") {
  console.error("the fake opencode server needs OPENCODE_PASSWORD");
  process.exit(1);
}
const version = process.env.FAKE_VERSION ?? "2.3.2";
const dir = process.cwd();
const dataDir = process.env.FAKE_DATA_DIR;
const { appendFileSync, existsSync, readFileSync, writeFileSync } = await import("node:fs");

const log = (name: string, value: unknown): void => appendFileSync(`${dir}/${name}`, `${JSON.stringify(value)}\n`);
const load = <T>(name: string, fallback: T): T => {
  if (!existsSync(`${dir}/${name}`)) return fallback;
  return JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as T;
};
const store = (name: string, value: unknown): void => writeFileSync(`${dir}/${name}`, JSON.stringify(value));

/** The sessions the server keeps, read back from the last run's file, as the real server reads its database. */
interface Kept {
  readonly id: string;
  readonly directory: string;
  readonly model?: { id: string; providerID: string };
  readonly permissions?: Array<Record<string, unknown>>;
  readonly title?: string;
}
let kept: Kept[] = load<Kept[]>("sessions.json", []);
const messages = new Map<string, Array<Record<string, unknown>>>();
let messageSeq = 0;
let userSeq = 0;

// -- the reading fixtures ------------------------------------------------------

/** The sessions of the data directory, as they stand at this call; `undefined` when the store cannot be read. */
const dataSessions = (): unknown[] | undefined => {
  try {
    return JSON.parse(readFileSync(`${dataDir}/sessions.json`, "utf8")) as unknown[];
  } catch {
    return undefined;
  }
};

/** The messages of one session of the data directory; `undefined` when they cannot be read. */
const dataMessages = (sessionID: string): unknown[] | undefined => {
  const path = `${dataDir}/messages-${sessionID}.json`;
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown[];
  } catch {
    return undefined;
  }
};

/** One page of a list, by the `limit` and `cursor` (an offset) the query names. */
const pageOf = <T>(items: readonly T[], url: URL): { data: T[]; cursor: { previous: null; next: string | null } } => {
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? items.length : Math.max(1, Number(limitRaw));
  const start = Math.max(0, Number(url.searchParams.get("cursor") ?? "0") || 0);
  const data = items.slice(start, start + limit);
  return { data, cursor: { previous: null, next: start + data.length < items.length ? String(start + data.length) : null } };
};

/** The whole session body the client unwraps, from what the fake keeps of it. */
const detailOf = (found: Kept): Record<string, unknown> => ({
  id: found.id,
  projectID: "prj_fake",
  agent: "build",
  ...(found.model === undefined ? {} : { model: found.model }),
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...(found.title === undefined ? {} : { title: found.title }),
  ...(found.permissions === undefined ? {} : { permissions: found.permissions }),
  location: { id: "loc_fake", directory: found.directory, canonical: found.directory },
});

// -- the event stream --------------------------------------------------------

interface Subscriber {
  push(event: Record<string, unknown>): void;
  close(): void;
}
const subscribers = new Set<Subscriber>();
let eventSeq = 0;
const emit = (type: string, data: Record<string, unknown>, durable: boolean): void => {
  eventSeq += 1;
  const event: Record<string, unknown> = {
    id: `evt_${eventSeq}`,
    created: Date.now(),
    type,
    ...(durable ? { durable: { aggregateID: "fake", seq: eventSeq, version: 1 } } : {}),
    data,
  };
  for (const subscriber of [...subscribers]) subscriber.push(event);
};

// -- the turns ---------------------------------------------------------------

let turnRunning = false;
let settlePermission: ((decision: string) => void) | undefined;
let settleForm: ((answer: Record<string, unknown> | undefined) => void) | undefined;
let releaseInterrupt: (() => void) | undefined;

function writeMessage(sessionID: string, message: Record<string, unknown>): void {
  const list = messages.get(sessionID) ?? [];
  list.push(message);
  messages.set(sessionID, list);
}

/** The answer a turn ends with, on the stream and in the transcript. */
function finish(sessionID: string, assistantID: string, answer: string): void {
  if (!turnRunning) return;
  turnRunning = false;
  emit("session.text.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }, true);
  emit("session.text.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: answer }, true);
  emit("session.execution.succeeded", { sessionID }, true);
  writeMessage(sessionID, {
    id: assistantID,
    time: { created: Date.now() },
    type: "assistant",
    agent: "build",
    model: { id: "default-model", providerID: "fake" },
    content: [{ type: "text", text: answer }],
    finish: "stop",
  });
}

async function runTurn(sessionID: string, text: string): Promise<void> {
  if (turnRunning) return;
  // A turn of an ask carries its intent before the JSON instruction a schema asks for; a plain
  // send is its own intent.
  const marker = "\n\nAnswer with JSON only, matching this schema exactly:";
  const intent = text.includes(marker) ? text.slice(0, text.indexOf(marker)) : text;
  turnRunning = true;
  messageSeq += 1;
  const assistantID = `msg_assistant_${messageSeq}`;
  emit("session.execution.started", { sessionID }, true);
  emit(
    "session.step.started",
    { sessionID, assistantMessageID: assistantID, agent: "build", model: { id: "default-model", providerID: "fake" }, started: Date.now() },
    true,
  );
  if (intent === "slow" || intent === "hang" || intent === "interrupt me" || intent === "bad admission") return;
  // The admission is answered before the process goes, so the death is a turn's, not a send's.
  if (intent === "die") {
    setTimeout(() => process.exit(3), 50);
    return;
  }
  if (intent === "fail") {
    // The failure comes a moment after the admission, so a watcher that subscribed between the
    // two still sees the turn end.
    setTimeout(() => {
      if (!turnRunning) return;
      turnRunning = false;
      emit("session.execution.failed", { sessionID, error: { type: "execution", message: "model exploded" } }, true);
    }, 50);
    return;
  }
  if (intent === "permission") {
    emit(
      "permission.asked",
      { id: "per_1", sessionID, action: "shell", resources: ["ls -la"], message: "the tool wants to run", metadata: { command: "ls -la" } },
      false,
    );
    const decision = await new Promise<string>((resolve) => {
      settlePermission = resolve;
    });
    settlePermission = undefined;
    if (decision === "reject") {
      turnRunning = false;
      emit("session.execution.failed", { sessionID, error: { type: "Permission.DeclinedError", message: "the tool was not allowed" } }, true);
      return;
    }
    finish(sessionID, assistantID, "after permission");
    return;
  }
  if (intent === "form" || intent === "external form") {
    const form = {
      id: "frm_test",
      sessionID,
      title: "Choose a topic",
      fields: intent === "form" ? [
        { key: "topic", type: "string", required: true, options: [{ value: "scoping", label: "Scope" }] },
        { key: "confirm", type: "boolean", required: true },
      ] : [{ key: "external", type: "external", url: "https://example.com/" }],
    };
    emit("form.created", { form }, false);
    const answer = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      settleForm = resolve;
    });
    settleForm = undefined;
    finish(sessionID, assistantID, answer === undefined ? "form dismissed" : JSON.stringify(answer));
    return;
  }
  if (intent === "script") {
    const steps = load<Array<{ event?: Record<string, unknown>; ms?: number }>>("script.json", []);
    for (const step of steps) {
      if (!turnRunning) return;
      if (step.ms !== undefined) await Bun.sleep(step.ms);
      else if (step.event !== undefined) {
        const event = step.event;
        const type = String(event.type ?? "");
        const data = { ...(event.data as Record<string, unknown> | undefined) };
        // A session event a step did not name a session for is this session's.
        if (type.startsWith("session.") && data.sessionID === undefined) data.sessionID = sessionID;
        emit(type, data, type.startsWith("session."));
      }
    }
    finish(sessionID, assistantID, "script done");
    return;
  }
  const answer =
    intent === "json"
      ? '{"word":"ok"}'
      : intent === "fenced"
        ? '```json\n{"word":"fenced"}\n```'
        : intent === "silent"
          ? "" // The transcript holds it; the stream says nothing.
          : "fake reply";
  if (intent === "silent" || intent === "silent after queue") {
    if (intent === "silent after queue") await Bun.sleep(150);
    if (!turnRunning) return;
    turnRunning = false;
    emit("session.execution.succeeded", { sessionID }, true);
    writeMessage(sessionID, {
      id: assistantID,
      time: { created: Date.now() },
      type: "assistant",
      agent: "build",
      model: { id: "default-model", providerID: "fake" },
      content: [{ type: "text", text: "from the transcript" }],
      finish: "stop",
    });
    return;
  }
  if (intent === "empty") {
    if (!turnRunning) return;
    turnRunning = false;
    emit("session.execution.succeeded", { sessionID }, true);
    return;
  }
  finish(sessionID, assistantID, answer);
}

function interrupt(sessionID: string): { interrupted: boolean } {
  if (!turnRunning) return { interrupted: false };
  turnRunning = false;
  settlePermission?.("reject");
  settlePermission = undefined;
  settleForm?.(undefined);
  settleForm = undefined;
  emit("session.execution.interrupted", { sessionID, reason: "user" }, true);
  return { interrupted: true };
}

// -- the server ---------------------------------------------------------------

const authorized = (request: Request): boolean =>
  request.headers.get("authorization") === `Basic ${btoa(`opencode:${password}`)}`;

const refuse = (tag: string, message: string, status = 401): Response =>
  new Response(JSON.stringify({ _tag: tag, message }), { status, headers: { "content-type": "application/json" } });

let sessionSeq = 0;
const hostnameFlag = process.argv.indexOf("--hostname");
const portFlag = process.argv.indexOf("--port");
const hostname = hostnameFlag === -1 ? "127.0.0.1" : process.argv[hostnameFlag + 1];
const server = Bun.serve({
  hostname,
  port: portFlag === -1 ? 0 : Number(process.argv[portFlag + 1]),
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // The body is read once, here: a Request body cannot be read twice.
    const body: Record<string, unknown> =
      request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    if (!path.startsWith("/control/")) {
      if (!authorized(request)) return refuse("UnauthorizedError", "the password was not given");
      log("requests.log", { method: request.method, path, body: request.method === "POST" ? body : undefined });
    }
    const parts = path.split("/").filter((part) => part !== "");

    if (request.method === "GET" && path === "/api/info") {
      return Response.json({ version, pid: process.pid, urls: [], paths: { tmp: "/tmp" } });
    }

    if (request.method === "POST" && path === "/api/session") {
      sessionSeq += 1;
      const id = `ses_fake-${sessionSeq}`;
      const directory = String((body.location as { directory?: string } | undefined)?.directory ?? dir);
      const keptSession: Kept = {
        id,
        directory,
        ...(body.model === undefined || body.model === null ? {} : { model: body.model as Kept["model"] }),
        ...(body.permissions === undefined || body.permissions === null ? {} : { permissions: body.permissions as Array<Record<string, unknown>> }),
        ...(body.title === undefined || body.title === null ? {} : { title: String(body.title) }),
      };
      kept = [...kept.filter((session) => session.id !== id), keptSession];
      store("sessions.json", kept);
      messages.set(id, []);
      // The session endpoints answer `{data: ...}`, which the client unwraps itself.
      return Response.json({
        data: {
          id,
          projectID: "prj_fake",
          agent: "build",
          ...(keptSession.model === undefined ? {} : { model: keptSession.model }),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() },
          ...(keptSession.title === undefined ? {} : { title: keptSession.title }),
          ...(keptSession.permissions === undefined || process.env["FAKE_OMIT_CREATED_PERMISSIONS"] === "1"
            ? {}
            : { permissions: keptSession.permissions }),
          location: { id: "loc_fake", directory, canonical: directory },
        },
      });
    }

    if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts.length === 2) {
      if (dataDir !== undefined) {
        const all = dataSessions();
        if (all === undefined) return refuse("InternalError", "the session store could not be read", 500);
        const filtered = all.filter((session) => {
          const row = session as { readonly parentID?: string; readonly location?: { readonly directory?: string } };
          const parent = url.searchParams.get("parentID");
          const directory = url.searchParams.get("directory");
          return (parent === null || row.parentID === parent) && (directory === null || row.location?.directory === directory);
        });
        const ordered = url.searchParams.get("order") === "desc" ? [...filtered].reverse() : filtered;
        return Response.json(pageOf(ordered, url));
      }
      return Response.json(pageOf(kept, url));
    }

    if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts.length === 3) {
      if (dataDir !== undefined) {
        const found = dataSessions()?.find((session) => (session as { readonly id?: string }).id === parts[2]);
        if (found === undefined) return refuse("SessionNotFoundError", `the session ${parts[2]} was not found`, 404);
        return Response.json({ data: found });
      }
      const found = kept.find((session) => session.id === parts[2]);
      if (found === undefined) return refuse("SessionNotFoundError", `the session ${parts[2]} was not found`, 404);
      return Response.json({ data: detailOf(found) });
    }

    if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "prompt") {
      const sessionID = parts[2] ?? "";
      const prompt = body as { text?: string; delivery?: string };
      if (!kept.some((session) => session.id === sessionID)) {
        return refuse("SessionNotFoundError", `the session ${sessionID} was not found`, 404);
      }
      userSeq += 1;
      writeMessage(sessionID, { id: `msg_user_${userSeq}`, time: { created: Date.now() }, type: "user", text: prompt.text ?? "" });
      // The turn runs after the admission was answered, as the real server's does.
      queueMicrotask(() => void runTurn(sessionID, prompt.text ?? ""));
      if (prompt.text === "bad admission") return new Response("{", { headers: { "content-type": "application/json" } });
      return Response.json({
        data: {
          id: `msg_user_${userSeq}`,
          sessionID,
          time: { created: Date.now() },
          type: "user",
          payload: { text: prompt.text ?? "" },
          delivery: prompt.delivery ?? "queue",
        },
      });
    }

    if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "interrupt") {
      if (process.env.FAKE_INTERRUPT_GATE === "1") {
        await new Promise<void>((resolve) => { releaseInterrupt = resolve; });
        releaseInterrupt = undefined;
      }
      return Response.json(interrupt(parts[2] ?? ""));
    }

    if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[3] === "message") {
      if (dataDir !== undefined) {
        const sessionID = parts[2] ?? "";
        if (!dataSessions()?.some((session) => (session as { readonly id?: string }).id === sessionID)) {
          return refuse("SessionNotFoundError", `the session ${sessionID} was not found`, 404);
        }
        const list = dataMessages(sessionID);
        if (list === undefined) return refuse("InternalError", `the messages of ${sessionID} could not be read`, 500);
        const ordered = url.searchParams.get("order") === "desc" ? [...list].reverse() : list;
        return Response.json(pageOf(ordered, url));
      }
      const list = messages.get(parts[2] ?? "") ?? [];
      const ordered = (url.searchParams.get("order") === "desc" ? [...list].reverse() : list).slice(
        0,
        Number(url.searchParams.get("limit") ?? list.length),
      );
      return Response.json({ data: ordered, cursor: { previous: null, next: null } });
    }

    if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "permission" && parts[5] === "reply") {
      const sessionID = parts[2] ?? "";
      const requestID = parts[4] ?? "";
      const decision = String(body["decision"] ?? "reject");
      log("replies.log", { sessionID, requestID, decision });
      emit("permission.replied", { sessionID, requestID, reply: decision }, false);
      settlePermission?.(decision);
      return new Response(null, { status: 204 });
    }

    if (parts[0] === "api" && parts[1] === "session" && parts[3] === "form" && parts[4] === "frm_test") {
      const sessionID = parts[2] ?? "";
      if (request.method === "POST" && parts[5] === "reply") {
        const answer = body["answer"] as Record<string, unknown>;
        emit("form.replied", { id: "frm_test", sessionID, answer }, false);
        settleForm?.(answer);
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE" && parts.length === 5) {
        emit("form.cancelled", { id: "frm_test", sessionID }, false);
        settleForm?.(undefined);
        return new Response(null, { status: 204 });
      }
    }

    if (request.method === "GET" && path === "/api/event") {
      let prune = (): void => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const subscriber: Subscriber = {
            push: (event) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                // The reader went away; the cancel below prunes the subscriber.
              }
            },
            close: () => {
              subscribers.delete(subscriber);
              controller.close();
            },
          };
          prune = () => subscribers.delete(subscriber);
          // The first delivery of a fresh subscription, as the real server's — held back when the
          // test plays a server whose stream stays silent (`FAKE_SILENT_STREAM`).
          subscribers.add(subscriber);
          if (process.env.FAKE_EMPTY_STREAM === "1") subscriber.close();
          else if (process.env.FAKE_SILENT_STREAM !== "1") subscriber.push({ id: "evt_0", type: "server.connected", data: {} });
        },
        cancel() {
          prune();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }

    if (request.method === "POST" && path === "/control/close-stream") {
      for (const subscriber of [...subscribers]) subscriber.close();
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path === "/control/release-interrupt") {
      if (releaseInterrupt === undefined) return new Response(null, { status: 409 });
      releaseInterrupt();
      return new Response(null, { status: 204 });
    }

    // The test's own channel: push an event onto the stream, as the server would.
    if (request.method === "POST" && path === "/control/push") {
      if (Object.keys(body).length === 0) return new Response("not an event", { status: 400 });
      const type = String(body["type"] ?? "unknown");
      // A pushed execution end is the server deciding the turn is over: the fake's own turn
      // ends with it, so what the session prompts next becomes a turn of its own.
      if (type.startsWith("session.execution.")) {
        turnRunning = false;
        settlePermission?.("reject");
        settlePermission = undefined;
      }
      emit(type, (body["data"] as Record<string, unknown> | undefined) ?? {}, type.startsWith("session."));
      return new Response(null, { status: 204 });
    }

    return refuse("UnknownError", `no route ${request.method} ${path}`, 404);
  },
});

appendFileSync(`${dir}/url.log`, `${JSON.stringify({ url: server.url.origin, pid: process.pid })}\n`);
// A server that never announces itself (`FAKE_SILENT_BOOT`): up, serving, saying nothing on stdout.
if (process.env.FAKE_SILENT_BOOT !== "1") {
  process.stdout.write(`${JSON.stringify({ url: process.env.FAKE_ANNOUNCED_URL ?? server.url.origin })}\n`);
}

// The server stays up while its stdin is open, and exits when it closes.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  server.stop(true);
  process.exit(0);
});
process.stdin.resume();

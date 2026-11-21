/**
 * A stand-in for `zcode app-server --stdio`. It logs what it is given: argv and the environment
 * (`argv.log`, `env.log`), every request (`requests.log`) and every answer to a request of its
 * own (`answers.log`). A turn takes 200 ms and answers "fake reply"; the content "hang" never ends
 * until `session/stop`, "fail" fails, "die" kills the process, "give the word" answers with JSON,
 * and "silent" ends with no answer in the event, so it is read back from the transcript. The files
 * "old-subscribe", "no-subscribe" and "resume-fail" change what it accepts.
 *
 * It speaks the wire as the real server does, in the shapes of the snapshot niwa types it with: every event
 * has its envelope and the payload its type needs, so a test that sends less says only what it means to
 * (`PAYLOADS` fills the rest). At the start of a turn it also sends what the real server sends there that is
 * not a turn: a request the snapshot does not know (`session/readReplyLanguage`) and a message of the v4 side
 * channel. `asked.log` holds every request of its own, so a test can check each answer against the method.
 *
 * The content "script" plays the steps in `script.json` in the turn, as the real server would, and
 * then completes the turn: `{ask: {method, params}, again?: n}` is a request of its own to the client
 * (announced again under a new id `n` times, as the real server does while it waits) which the turn
 * waits to be answered, unless `wait` is false; `{event: {type, payload}}` is a session event; `{ms}` is a pause. A
 * `session/stop` resolves what the turn still waits for, with the `permission.resolved` event the
 * real server sends, and ends the turn as cancelled.
 */
export const ZCODE_FAKE = `#!/usr/bin/env bun
const { appendFileSync, existsSync } = await import("node:fs");
const dir = import.meta.dir;
const log = (name, value) => appendFileSync(dir + "/" + name, JSON.stringify(value) + "\\n");
log("argv.log", process.argv.slice(2));
log("env.log", { id: process.env.NIWA_ID, pid: process.pid });
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const subscribeKind = () => (existsSync(dir + "/old-subscribe") ? "desktop" : "desktop-continuous");

let session = "sess_fake-1";
let active;
let requestsOfServer = 0;
const askClient = (method, params) => {
  requestsOfServer += 1;
  log("asked.log", { id: "server-" + requestsOfServer, method });
  out({ id: "server-" + requestsOfServer, method, params });
  return "server-" + requestsOfServer;
};
const answerWaiters = new Map();
const unanswered = new Map();
const answered = (id) => new Promise((resolve) => { answerWaiters.set(id, resolve); });
async function playScript() {
  const steps = JSON.parse(await Bun.file(dir + "/script.json").text());
  for (const step of steps) {
    if (active === undefined) return;
    if (step.ms !== undefined) await Bun.sleep(step.ms);
    else if (step.event !== undefined) event(step.event.type, step.event.payload);
    else if (step.ask !== undefined) {
      const first = askClient(step.ask.method, step.ask.params);
      unanswered.set(first, step.ask.params.requestId);
      const done = answered(first).then(() => unanswered.delete(first));
      for (let again = 0; again < (step.again ?? 0); again += 1) askClient(step.ask.method, step.ask.params);
      if (step.wait !== false) await done;
    }
  }
  if (active !== undefined) { active = undefined; event("turn.completed", { response: "fake reply", resultType: "success" }); }
}
let eventSeq = 0;
/** What the snapshot needs in the payload of an event, so that a test names only what it cares about. */
const PAYLOADS = {
  "turn.started": { turnNumber: 0, input: "" },
  "turn.steerQueued": { pendingInputId: "pending-1", input: "more", inputPreview: "more", inputSize: 4, targetTurnId: "turn-1", queueLength: 1 },
  "model.streaming": { kind: "text_delta" },
  "turn.completed": { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
  "turn.failed": { turnPhase: "execution" },
};
const event = (type, payload) => {
  eventSeq += 1;
  out({ method: "session/event", params: { eventId: "event-" + eventSeq, sessionId: session, seq: eventSeq, timestamp: Date.now(), deliveryKind: "desktop-continuous", type, payload: { ...PAYLOADS[type], ...payload } } });
};
const snapshot = () => ({ protocol: { name: "ZCode Protocol", version: 1 }, session: { sessionId: session, mode: "build", model: { providerId: "fake", modelId: "default-model" } } });
const workspace = { workspacePath: dir, workspaceKey: dir };

const permissionParams = (requestId, toolName, input) => ({
  requestId, sessionId: session, toolCallId: "call-" + requestId, toolName, reason: "the tool wants to run", riskLevel: "medium", input,
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { decision: "allow", reason: "Approved once" } },
    { optionId: "allow_project", kind: "allow_always", name: "Always allow in this project", description: "Do not ask again", response: { decision: "allow", reason: "Approved for this project", permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName }] }] } },
    { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny", reason: "The user does not want this." } },
  ],
});

function turn(content) {
  active = content;
  askClient("session/requestRuntimePreferences", { sessionId: session, scope: "user-execution" });
  askClient("interaction/requestOfficialMcpAuthHeaders", { requestId: "official-mcp-auth:1", workspace, pluginId: "zcode-site@zcode-plugins-official", mcpKey: "sites", targetOrigin: "https://zcode.z.ai" });
  askClient("session/readReplyLanguage", { sessionId: session });
  out({ method: "v4/conversation/contextCompositionChanged", params: { sessionId: session, revision: 1 } });
  if (content.includes("needs permission")) askClient("interaction/requestPermission", permissionParams("perm-1", "Bash", { command: "ls" }));
  out({ method: "state.updated", params: { type: "state.updated", scope: "session", sessionId: session, revision: 1, patch: { status: "running" } } });
  event("turn.started", { input: content });
  event("model.streaming", { delta: "x", kind: "text_delta" });
  if (content === "hang") return;
  if (content === "script") return void playScript();
  if (content === "die") process.exit(3);
  const settle = (name, payload) => { if (active === undefined) return; active = undefined; event(name, payload); };
  if (content.startsWith("fail")) return void setTimeout(() => settle("turn.failed", { error: { type: "execution", message: "model exploded" } }), 50);
  const response = content.includes("give the fenced word")
    ? "Here it is: \`\`\`json\\n{\\"word\\":\\"fenced\\"}\\n\`\`\`"
    : content.includes("give the word") ? '{"word":"ok"}'
    : content.startsWith("silent") ? ""
    : "fake reply";
  setTimeout(() => {
    settle("turn.completed", { response, resultType: "success" });
    if (content === "stray") setTimeout(() => event("turn.completed", { response, resultType: "success" }), 30);
  }, content === "slow" ? 600 : 200);
}

const message = (role, text) => ({
  info: role === "user"
    ? { messageId: "msg-" + role, sessionId: session, role, time: { created: 1 }, agent: "build" }
    : { messageId: "msg-" + role, sessionId: session, role, time: { created: 2 }, parentMessageId: "msg-user", agent: "build", path: { cwd: dir, root: dir }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  parts: [{ partId: "part-" + role, sessionId: session, messageId: "msg-" + role, type: "text", text }],
});

function handle({ id, method, params }) {
  const ok = (result) => out({ id, result });
  switch (method) {
    case "runtime/capabilities": return ok({ independentPlanState: true });
    case "session/create": askClient("session/requestRuntimePreferences", { sessionId: session, scope: "runtime-materialization" }); return ok(snapshot());
    case "session/resume":
      if (existsSync(dir + "/resume-fail")) return out({ id, error: { code: -32603, message: "no such session" } });
      session = params.sessionId; return ok(snapshot());
    case "session/subscribe":
      if (existsSync(dir + "/no-subscribe") || params.deliveryKind !== subscribeKind()) return out({ id, error: { code: -32602, message: "invalid_value in deliveryKind" } });
      return ok({ sessionId: params.sessionId, eventSeq: 0, events: [] });
    case "session/send":
      ok({ accepted: true, sessionId: params.sessionId, stateRevision: 1 });
      if (active !== undefined) return void event("turn.steerQueued", {});
      return void turn(params.content);
    case "session/stop":
      ok({});
      if (active !== undefined) {
        active = undefined;
        for (const requestId of unanswered.values()) event("permission.resolved", { requestId, toolCallId: "call-" + requestId });
        setTimeout(() => event("turn.completed", { resultType: "cancelled", response: "" }), 50);
      }
      return;
    case "session/messages":
      return ok({ messages: [message("user", "q"), message("assistant", "from the transcript")] });
    default: return out({ id, error: { code: -32601, message: "method not found" } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line === "") continue;
    const frame = JSON.parse(line);
    if (frame.method === undefined) { log("answers.log", frame); answerWaiters.get(frame.id)?.(); }
    else { log("requests.log", frame); handle(frame); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

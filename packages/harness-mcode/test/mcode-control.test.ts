/**
 * The MiniMax Code control side.
 *
 * The live test runs the real `mcode` on the model the check names, and it is skipped unless
 * `NIWA_LIVE=1` and the binary is on PATH (`NIWA_MCODE_LINEAGE=fork` when it is the fork). It proves the whole path: a start that names the
 * session and ends its turn, a message that starts a turn and ends it, a resume that carries a
 * second message, an answer by schema, and no process left behind.
 *
 * The signs of life are a forward-only stream: a watcher sees what happens from the moment it
 * subscribes, and nothing before it. So every step subscribes first and only then triggers the
 * action, and it waits for the first turn that ends — never for a turn number it guessed.
 *
 * Every test disposes its control side, so no child outlives it.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";

import {
  HarnessInstanceRegistry,
  HarnessKindRegistry,
  Unsupported,
  harnessId,
  modelName,
  promptFromText,
  sessionId,
  type LifeEvent,
  type ModelName,
  type SessionId,
} from "@niwa-labs/harness";
import {
  mcodeControl,
  mcodeModelOptionValue,
  servesSteer,
  type McodeSessionControl,
  type MinimaxLineage,
} from "../src/mcode/control.ts";
import { homeNameOfProfile, homeOfProfile } from "../src/mcode/paths.ts";
import { mcode, mcodeKind } from "../src/mcode/index.ts";
import { ncode, ncodeKind } from "../src/ncode/index.ts";
import { eventually, tempDir, live } from "@niwa-labs/testing";
import { onSpawn, resolveProfile } from "@niwa-labs/sandbox";

let dir = "";
let control: McodeSessionControl | undefined;

afterEach(async () => {
  await control?.dispose();
  control = undefined;
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});

/**
 * Subscribe to the signs of life and wait for the first turn that ends.
 *
 * The subscription is made when this is called, before the action that starts the turn: the
 * stream is forward-only, so a watcher that arrives after the turn ended sees nothing of it.
 */
function firstTurnEnded(stream: AsyncIterable<LifeEvent>): Promise<LifeEvent[]> {
  return new Promise<LifeEvent[]>((resolve, reject) => {
    const events: LifeEvent[] = [];
    void (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.kind === "turn-ended") {
          resolve(events);
          return;
        }
      }
      reject(new Error("the session ended before a turn did"));
    })().catch(reject);
  });
}

/** The turn of the events, or undefined when the events do not name one. */
function turnOf(events: readonly LifeEvent[], kind: "turn-started" | "turn-ended"): number | undefined {
  for (const event of events) {
    if (event.kind === kind) return event.turn;
  }
  return undefined;
}

/** The pids of the processes this process started directly, with their command. */
function directChildren(): Array<{ pid: number; pgid: number; command: string }> {
  const listed = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,pgid=,command="]).stdout.toString();
  const found: Array<{ pid: number; pgid: number; command: string }> = [];
  for (const line of listed.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = match[4] ?? "";
    // The `ps` that reads the table is itself a child of this process.
    if (command.startsWith("ps ")) continue;
    if (Number(match[2]) !== process.pid) continue;
    found.push({ pid: Number(match[1]), pgid: Number(match[3]), command });
  }
  return found;
}

/** The pids of the processes in the process group with this id. */
function groupMembers(pgid: number): number[] {
  const listed = Bun.spawnSync(["ps", "-e", "-o", "pid=,pgid="]).stdout.toString();
  const found: number[] = [];
  for (const line of listed.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    if (Number(match[2]) === pgid) found.push(Number(match[1]));
  }
  return found;
}

const liveLineage = process.env["NIWA_MCODE_LINEAGE"] === "fork" ? "fork" : "upstream";
const liveProgram = liveLineage === "fork" ? "ncode" : "mcode";

test.skipIf(!(live && Bun.which(liveProgram)))(
  "the real agent starts, names the session, ends a turn, sends, resumes, answers by schema and leaves no process",
  async () => {
    dir = await tempDir("mcode-control");
    const before = directChildren();
    control = mcodeControl({
      mode: "full",
      harness: harnessId("mcode-proof"),
      // The handshake refuses a binary of the other lineage: say which one is on the path.
      lineage: liveLineage,
      model: "minimax/MiniMax-M3.1-Flash",
      turnTimeoutMs: 120_000,
    });

    // 1. The start names the session and returns; its prompt is the first turn, and that turn
    //    ends.
    //
    // The first turn begins inside the start, before there is an id to watch. The side keeps
    // its signs for the first stream of life, so that stream sees it begin and end.
    const { session: id, first } = await control.start({
      prompt: promptFromText("reply with ok"),
      cwd: dir,
    });
    expect(id.native.length).toBeGreaterThan(0);
    expect(id.harness).toBe(harnessId("mcode-proof"));
    expect(first).toMatchObject({ status: "started", turn: 1 });
    expect(turnOf(await firstTurnEnded(control.life(id)), "turn-ended")).toBe(1);
    expect(await control.state(id)).toBe("idle");

    // The agent this side started is a child of this process, in a group of its own.
    const agent = directChildren().find((child) => !before.some((old) => old.pid === child.pid));
    expect(agent).toBeDefined();
    const pgid = agent?.pgid ?? 0;

    // 2. A second message: the subscription is made first, the turn it watches is the
    //    turn the receipt names, and it ends.
    const sent = firstTurnEnded(control.life(id));
    const receipt = await control.send(id, "reply with ok again");
    expect(receipt.status).toBe("started");
    const sentEvents = await sent;
    // The turn that ended is the turn the receipt named — not a number this test guessed.
    expect(turnOf(sentEvents, "turn-ended")).toBe(receipt.turn);
    expect(turnOf(sentEvents, "turn-started")).toBe(receipt.turn);
    expect(await control.state(id)).toBe("idle");

    // 3. A resume carries a second message, and that turn ends too. The subscription
    //    is made first: the turn may end before the resume returns.
    const resumed = firstTurnEnded(control.life(id));
    await control.resume(id, { prompt: promptFromText("reply with ok once more") });
    const resumedEvents = await resumed;
    expect(turnOf(resumedEvents, "turn-ended")).toBe(turnOf(resumedEvents, "turn-started"));
    expect(await control.state(id)).toBe("idle");

    // 4. An answer by schema: the value that comes back passed the schema.
    const asked = firstTurnEnded(control.life(id));
    const answer = await control.ask(id, {
      schema: z.object({ word: z.string() }),
      prompt: promptFromText("Give the word ok."),
    });
    expect(turnOf(await asked, "turn-ended")).toBeDefined();
    expect(answer.session).toEqual(id);
    expect(answer.value.word.toLowerCase()).toContain("ok");

    // 5. An interrupt ends the running turn, and the session stays usable. The
    //    subscription is made first, and the interrupt waits for the turn to be running.
    const cut = firstTurnEnded(control.life(id));
    const long = await control.send(id, "count from 1 to 500, one number per line");
    expect(long.status).toBe("started");
    await control.interrupt(id);
    expect(turnOf(await cut, "turn-ended")).toBe(long.turn);
    expect(await control.state(id)).toBe("idle");

    // 6. No process is left behind: the group this side started is empty, and the
    //    agent is not a child of this process any more.
    await control.dispose();
    control = undefined;
    const deadline = Date.now() + 10_000;
    while (groupMembers(pgid).length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(groupMembers(pgid)).toEqual([]);
    expect(directChildren().some((child) => !before.some((old) => old.pid === child.pid))).toBe(
      false,
    );
  },
  300_000,
);

test("the control side refuses a session it does not have", async () => {
  dir = await tempDir("mcode-control");
  control = mcodeControl({ mode: "full", harness: harnessId("mcode-proof") });
  let refused: unknown;
  try {
    await control.send(sessionId(harnessId("mcode-proof"), "no-such-session"), "hello");
  } catch (error) {
    refused = error;
  }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain("no-such-session");
});

test("the model option is the one the session advertises", () => {
  // The agent refuses a model it does not advertise, so the advertised one wins.
  const advertised = [
    { value: "m:minimax:MiniMax-M3.1-Flash:v:", name: "M3.1-Flash" },
    { value: "m:minimax:MiniMax-M3.1-Flash:v:thinking", name: "M3.1-Flash · thinking" },
  ];
  expect(mcodeModelOptionValue("minimax/MiniMax-M3.1-Flash", advertised)).toBe(
    "m:minimax:MiniMax-M3.1-Flash:v:thinking",
  );
  // An exact advertisement is used as it is.
  expect(mcodeModelOptionValue("minimax/MiniMax-M3.1-Flash#thinking", advertised)).toBe(
    "m:minimax:MiniMax-M3.1-Flash:v:thinking",
  );
  // Without an advertisement the id is encoded as it is.
  expect(mcodeModelOptionValue("minimax/MiniMax-M3.1-Flash")).toBe(
    "m:minimax:MiniMax-M3.1-Flash:u",
  );
  // A value the agent named is an option value already: it is not taken for an id and encoded again, advertised or not.
  expect(mcodeModelOptionValue("m:minimax:MiniMax-M3.1-Flash:v:", advertised)).toBe("m:minimax:MiniMax-M3.1-Flash:v:");
  expect(mcodeModelOptionValue("m:minimax:MiniMax-M3.1-Flash:v:thinking")).toBe("m:minimax:MiniMax-M3.1-Flash:v:thinking");
  expect(mcodeModelOptionValue("m:minimax:MiniMax-M3.1-Flash:u")).toBe("m:minimax:MiniMax-M3.1-Flash:u");
});

/**
 * A stand-in for `mcode acp`: it answers the handshake and every config call, ends every prompt after a short wait,
 * dies on the prompt "die", never ends the prompt "hang" until it is cancelled, and answers a
 * prompt that begins with "give the word" with the JSON `{"word":"ok"}`. Like real mcode it
 * refuses a prompt while another one is active, and answers a cancelled prompt a little later.
 *
 * The params of every `session/new` and `session/load` are written to a file, so a test can read
 * what the agent was asked for.
 */
const FAKE_AGENT = `#!/usr/bin/env bun
const decoder = new TextDecoder();
const { appendFileSync, existsSync, readFileSync } = await import("node:fs");
if (process.argv.slice(2).join(" ") === "acp --help") {
  const help = new URL("tool-help", import.meta.url);
  if (existsSync(help)) {
    appendFileSync(new URL("probe.log", import.meta.url), JSON.stringify({
      cwd: process.cwd(), path: process.env.PATH, sessionEnv: process.env.NIWA_ID !== undefined,
      nodeOptions: process.env.NODE_OPTIONS !== undefined, sentinel: process.env.PROBE_SENTINEL !== undefined,
    }) + "\\n");
    process.stdout.write(readFileSync(help, "utf8"));
  }
  process.exit(0);
}
let buffer = "";
let active;
let model;
let structuredPrompt;
const structuredScenario = new URL("structured-scenario", import.meta.url);
appendFileSync(${JSON.stringify(join(dir, "argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
appendFileSync(${JSON.stringify(join(dir, "env.log"))}, JSON.stringify({ mode: process.env.MCODE_SERVER_MODE, id: process.env.NIWA_ID }) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let at = buffer.indexOf("\\n");
  while (at !== -1) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\\n");
    if (message.method === "initialize") {
      // A fork of mcode lists the steer request; the file "steer" makes the fake one. The file
      // "fork" makes the fake the owner's fork, which serves the turn status and the history; the
      // file "status" alone makes it serve the turn status.
      const forked = existsSync(${JSON.stringify(join(dir, "fork"))});
      const methods = [
        ...(existsSync(${JSON.stringify(join(dir, "steer"))}) ? ["mcode/session/steer"] : []),
        ...(forked || existsSync(${JSON.stringify(join(dir, "status"))}) ? ["mcode/session/turn_status"] : []),
        ...(forked ? ["session/history"] : []),
        // The file "tools-method" makes the fake a build with the fork's tool policy capability.
        ...(existsSync(${JSON.stringify(join(dir, "tools-method"))}) ? ["mcode/session/tools"] : []),
      ];
      const meta = methods.length > 0 ? { "minimax-code/extensions": { version: 1, methods, notifications: [] } } : undefined;
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, _meta: meta } });
    }
    else if (message.method === "mcode/session/turn_status") {
      // The file "foreign-turn" is a turn the daemon runs for a client that is gone. The file
      // "release" makes the daemon drop the turn it holds without answering its prompt.
      if (existsSync(${JSON.stringify(join(dir, "release"))})) active = undefined;
      // The file "status-error" makes the request fail, as a build that lists it and cannot serve it.
      if (existsSync(${JSON.stringify(join(dir, "status-error"))})) {
        appendFileSync(${JSON.stringify(join(dir, "status.log"))}, "error\\n");
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        continue;
      }
      const busy = existsSync(${JSON.stringify(join(dir, "foreign-turn"))}) || active !== undefined;
      appendFileSync(${JSON.stringify(join(dir, "status.log"))}, (busy ? "busy" : "idle") + "\\n");
      send({ jsonrpc: "2.0", id: message.id, result: { activeTurn: busy ? { turnId: "t0", busyReason: "turn", locallyOwned: true } : null, latestActivity: null, queue: { pendingCount: 0, paused: false } } });
    }
    else if (message.method === "mcode/session/steer") {
      // The file "steer-refuse" is what the fork answers a steer it did not deliver: invalid params.
      if (existsSync("steer-refuse")) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Steering was not delivered to the active ACP prompt Turn" } }); continue; }
      appendFileSync(${JSON.stringify(join(dir, "steers.log"))}, JSON.stringify(message.params) + "\\n");
      // The file "steer-fail" is a steer the fork took and then failed on: an internal error.
      if (existsSync("steer-fail")) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error", data: "the receipt was not written" } }); continue; }
      if (existsSync("steer-hang")) continue;
      send({ jsonrpc: "2.0", id: message.id, result: { turnId: "t1", mode: "steered" } });
    }
    else if ((message.method === "session/new" || message.method === "session/load") && existsSync(${JSON.stringify(join(dir, "refuse-mode"))})) {
      // The file "refuse-mode" is an old daemon: it cannot take the mode of a session.
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "runtime does not support per-session permissionMode; restart mcoded" } });
    }
    else if ((message.method === "session/new" || message.method === "session/load") && existsSync(${JSON.stringify(join(dir, "refuse-tool-policy"))})) {
      // The file "refuse-tool-policy" is a daemon older than the binary's advertisement: it
      // cannot take the tool policy of a session.
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "runtime does not support per-session tool policy; restart mcoded" } });
    }
    else if ((message.method === "session/new" || message.method === "session/load") && existsSync(${JSON.stringify(join(dir, "refuse-tools-unknown"))})) {
      // The file "refuse-tools-unknown" is the fork's fail-closed answer to a policy naming a
      // tool outside its stable catalog.
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown tool names in \\"minimax-code/toolPolicy\\": no_such_tool", data: { unknown: ["no_such_tool"] } } });
    }
    else if (message.method === "mcode/session/tools") {
      appendFileSync(${JSON.stringify(join(dir, "tools.log"))}, JSON.stringify(message.params) + "\\n");
      // Answers as the fork does: the policy the LAST session request bound, and the effective
      // set it keeps. The file "ignore-policy" makes it answer legacy instead: a build that
      // nods at the _meta but keeps every tool.
      const logged = existsSync(${JSON.stringify(join(dir, "sessions.log"))})
        ? readFileSync(${JSON.stringify(join(dir, "sessions.log"))}, "utf8").trim().split("\\n").filter((line) => line !== "")
        : [];
      const last = logged.length > 0 ? JSON.parse(logged[logged.length - 1]) : {};
      const bound = existsSync(${JSON.stringify(join(dir, "ignore-policy"))}) ? undefined : last._meta?.["minimax-code/toolPolicy"];
      const catalog = [{ name: "read", source: "builtin" }, { name: "bash", source: "builtin" }];
      send({ jsonrpc: "2.0", id: message.id, result: {
        policy: bound === undefined ? { mode: "legacy" } : { mode: "allow", allow: bound.allow, servers: [] },
        catalog,
        effective: bound === undefined ? catalog.map((entry) => entry.name) : bound.allow.filter((name) => catalog.some((entry) => entry.name === name)),
      } });
    }
    else if (message.method === "session/new") {
      appendFileSync(${JSON.stringify(join(dir, "sessions.log"))}, JSON.stringify(message.params) + "\\n");
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-1" } });
    }
    else if (message.method === "session/load") {
      appendFileSync(${JSON.stringify(join(dir, "sessions.log"))}, JSON.stringify(message.params) + "\\n");
      // Real mcode answers session/load with no session id: the session is the one asked for.
      // A test may make it name one, written in the file "load-id".
      const named = existsSync(${JSON.stringify(join(dir, "load-id"))})
        ? { sessionId: readFileSync(${JSON.stringify(join(dir, "load-id"))}, "utf8") }
        : {};
      send({ jsonrpc: "2.0", id: message.id, result: { modes: {}, configOptions: [], ...named } });
    }
    else if (message.method === "session/history" && existsSync(structuredScenario)) {
      // A schema-valid reply for this exact prompt would let the old fallback mask an invalid ACP answer.
      appendFileSync(new URL("history.log", import.meta.url), "read\\n");
      send({ jsonrpc: "2.0", id: message.id, result: { entries: [
        { role: "user", text: structuredPrompt },
        { role: "assistant", text: JSON.stringify({ answer: "from history" }) },
      ] } });
    }
    else if (message.method === "session/prompt") {
      appendFileSync(${JSON.stringify(join(dir, "prompts.log"))}, JSON.stringify(message.params) + "\\n");
      if (existsSync(structuredScenario)) {
        const scenario = JSON.parse(readFileSync(structuredScenario, "utf8"));
        const update = (text, messageId, sessionUpdate = "agent_message_chunk", sessionId = "fake-1", _meta) =>
          ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
            sessionUpdate, messageId, _meta,
            ...(sessionUpdate === "tool_call"
              ? { toolCallId: "synthetic-tool", title: "Synthetic tool" }
              : { content: { type: "text", text } }),
          } } });
        structuredPrompt = message.params.prompt[0].text;
        const result = { jsonrpc: "2.0", id: message.id, result: { stopReason: scenario.stopReason ?? "end_turn" } };
        const frames = [...scenario.updates.map(args => update(...args)), result];
        // Exercise split ACP frames and the last update adjacent to the prompt result.
        const wire = frames.map(frame => JSON.stringify(frame) + "\\n").join("");
        process.stdout.write(wire.slice(0, 27));
        process.stdout.write(wire.slice(27));
        continue;
      }
      // Like real mcode: a session whose daemon runs a turn for another client refuses a prompt.
      if (existsSync(${JSON.stringify(join(dir, "foreign-turn"))})) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error: MiniMax Code refused the prompt (local_session_busy): Session already has an active Turn. Use queue send to deliver the message after it.", data: { code: "local_session_busy", retryable: false } } }); continue; }
      // Like real mcode: one prompt at a time per session.
      if (active !== undefined) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params: A prompt is already active for this session." } }); continue; }
      if (message.params.prompt[0].text === "die") process.exit(3);
      // "stall" ends its turn and then stops reading its input for a while, as a stuck agent does.
      if (message.params.prompt[0].text === "stall") {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
        continue;
      }
      // "orphan" ends its turn and exits, leaving a grandchild that holds the agent's stdout open: the
      // process is gone and its input is closed, but the pipe of its output has not closed yet.
      if (message.params.prompt[0].text === "orphan") {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        Bun.spawn(["sleep", "300"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
        setTimeout(() => process.exit(0), 50);
        continue;
      }
      active = message.id;
      // "hang" never ends on its own; a cancel ends it, a little later, as cancelled.
      if (message.params.prompt[0].text === "hang") continue;
      if (message.params.prompt[0].text.startsWith("give the word")) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ word: "ok" }) } } } });
      }
      // The file "ask-permission" makes the turn ask for permission, with the fork's options, the
      // lasting ones first. The file "only-always" leaves out the one-off ones.
      if (existsSync(${JSON.stringify(join(dir, "ask-permission"))})) {
        const options = [
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny-always", name: "Always deny", kind: "reject_always" },
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ];
        // The file "questionnaire" makes it a question for the person, in the shape a client without form support gets it.
        const questionnaire = [
          { optionId: "questionnaire:c9:red", name: "red", kind: "allow_once" },
          { optionId: "questionnaire:c9:blue", name: "blue", kind: "allow_once" },
          { optionId: "questionnaire:c9:cancel", name: "Cancel", kind: "reject_once" },
        ];
        send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: "fake-1", toolCall: { toolCallId: "c9", title: existsSync(${JSON.stringify(join(dir, "questionnaire"))}) ? "Which colour?" : "Bash" }, options: existsSync(${JSON.stringify(join(dir, "questionnaire"))}) ? questionnaire : existsSync(${JSON.stringify(join(dir, "only-always"))}) ? options.slice(0, 2) : options } });
      }
      // The file "tool-calls" makes the turn report tool calls; the fork marks them with its decision.
      if (existsSync(${JSON.stringify(join(dir, "tool-calls"))})) {
        const update = (sessionUpdate, toolCallId, _meta) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate, toolCallId, ...(sessionUpdate === "tool_call" ? { title: "Read", kind: "read", status: "pending" } : { status: "completed" }), ...(_meta === undefined ? {} : { _meta }) } } });
        update("tool_call", "c1", { "minimax-code/permission": { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto", reason: "read only" } });
        update("tool_call_update", "c1");
        update("tool_call", "c2", { "minimax-code/permission": { decision: "maybe" } });
        update("tool_call", "c3", { "minimax-code/permission": { decision: "deny", decidedBy: "rule", ruleKind: "builtin", mode: "default", reason: "denied by a rule" } });
        update("tool_call", "c4", { "minimax-code/permission": { decision: "allow", decidedBy: "mode", mode: "bypassPermissions", reason: "bypassPermissions mode" } });
      }
      setTimeout(() => { if (active === message.id) { active = undefined; send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }); } }, 200);
    } else if (message.method === undefined && message.id === "perm-1") {
      appendFileSync(${JSON.stringify(join(dir, "permission.log"))}, JSON.stringify(message.result) + "\\n");
    } else if (message.method === "session/cancel") {
      // The file "deaf" makes the daemon ignore the cancel: the turn stays held.
      if (existsSync(${JSON.stringify(join(dir, "deaf"))})) continue;
      const cut = active;
      if (cut !== undefined) setTimeout(() => { if (active === cut) { active = undefined; send({ jsonrpc: "2.0", id: cut, result: { stopReason: "cancelled" } }); } }, 300);
    } else if (message.method === "session/set_config_option") {
      appendFileSync(${JSON.stringify(join(dir, "config.log"))}, JSON.stringify(message.params) + "\\n");
      // The file "refuse-effort" makes the agent refuse an effort, as the real one refuses a value its model does not advertise.
      if (message.params.configId === "thinkingEffort" && existsSync(${JSON.stringify(join(dir, "refuse-effort"))})) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params: Thinking effort is not advertised for the selected model: " + message.params.value } });
        continue;
      }
      if (message.params.configId === "model") model = message.params.value;
      // The file "reports-model" makes the agent list the options as they stand, as the protocol has it: the current model among them.
      const options = existsSync(${JSON.stringify(join(dir, "reports-model"))}) ? { configOptions: [{ id: "model", currentValue: model ?? "m:minimax:MiniMax-M3.1-Flash:u" }] } : {};
      send({ jsonrpc: "2.0", id: message.id, result: options });
    } else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}
`;

/** The params of every `session/new` and `session/load` the fake agent was asked for. */
const sessionRequestsOf = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, "sessions.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The params of every config option the fake agent was asked to set. */
const configCallsOf = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, "config.log"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function fakeControl(options?: {
  lineage?: MinimaxLineage;
  permissions?: "allow" | "deny";
  steer?: boolean;
  files?: readonly string[];
  callTimeoutMs?: number;
  cancelGraceMs?: number;
  turnTimeoutMs?: number;
}): Promise<McodeSessionControl> {
  dir = await tempDir("mcode-fake");
  if (options?.steer === true) await writeFile(join(dir, "steer"), "");
  for (const file of options?.files ?? []) await writeFile(join(dir, file), "");
  // A turn status is the fork's: an agent that serves it is the fork, and this side is set up for it.
  const lineage = options?.lineage ?? (options?.files?.includes("status") === true ? "fork" : undefined);
  if (lineage === "fork") await writeFile(join(dir, "fork"), "");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  return mcodeControl({
    mode: "full",
    harness: harnessId("mcode-fake"),
    binary,
    ...(lineage === undefined ? {} : { lineage }),
    ...(options?.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options?.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options?.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    ...(options?.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
  });
}

test("structured Ncode ask keeps final message deltas together without consulting history", async () => {
  control = await fakeControl({ lineage: "fork" });
  await writeFile(join(dir, "structured-scenario"), JSON.stringify({
    updates: [
      ['```json\n{"answer":"intermediate"}\n```', "early"],
      ["", null, "tool_call"],
      ["thinking", "final", "agent_thought_chunk"],
      ['{"answer":"', "final"],
      ["straggler", "early"],
      ["wrong session", "alien", "agent_message_chunk", "other"],
      ["service text", "service", "agent_message_chunk", "fake-1", { informational: true }],
      ['ok"}', "final"],
    ],
  }));
  const { session } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const ended = firstTurnEnded(control.life(session));
  const result = await control.ask(session, { prompt: promptFromText("ask"), schema: z.object({ answer: z.string() }) });
  expect(result.value).toEqual({ answer: "ok" });
  expect((await ended).find((event) => event.kind === "turn-ended")).not.toHaveProperty("answer");
  expect(existsSync(join(dir, "history.log"))).toBe(false);
});

test("structured Ncode ask rejects the ACP schema mismatch even with a valid persisted answer", async () => {
  control = await fakeControl({ lineage: "fork" });
  await writeFile(join(dir, "structured-scenario"), JSON.stringify({
    updates: [['{"answer":42,"privateKey":"sensitive synthetic value"}', "final"]],
  }));
  const { session } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const schema = z.object({ answer: z.string() });
  const error: unknown = await control.ask(session, { prompt: promptFromText("ask"), schema })
    .catch((failure: unknown) => failure);
  expect(String(error)).toMatch(/invalid_type at depth 1; ACP json \(object\), \d+ chars, 1 text chunks, 1 named messages/);
  expect(String(error)).not.toMatch(/sensitive synthetic value|privateKey|history/);
  expect(existsSync(join(dir, "history.log"))).toBe(false);
  const sent = JSON.parse((await readFile(join(dir, "prompts.log"), "utf8")).trim());
  expect(sent.prompt).toEqual([{
    type: "text",
    text: [
      "ask",
      "",
      "Answer with JSON only, matching this schema exactly:",
      JSON.stringify(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" })),
    ].join("\n"),
  }]);
});

for (const [boundary, update] of [
  ["a new thought", ["thinking", "final", "agent_thought_chunk"]],
  ["a tool call", ["", null, "tool_call"]],
] as const) {
  test("structured Ncode ask discards intermediate text after " + boundary, async () => {
    control = await fakeControl({ lineage: "fork" });
    await writeFile(join(dir, "structured-scenario"), JSON.stringify({
      updates: [['{"answer":"intermediate"}', "early"], update],
    }));
    const { session } = await control.start({ prompt: promptFromText(""), cwd: dir });
    await expect(control.ask(session, { prompt: promptFromText("ask"), schema: z.object({ answer: z.string() }) }))
      .rejects.toThrow(/invalid_type at root; ACP empty \(undefined\), 0 chars/);
    expect(existsSync(join(dir, "history.log"))).toBe(false);
  });
}

test("structured Ncode ask rejects a token limit even with schema-valid text", async () => {
  control = await fakeControl({ lineage: "fork" });
  await writeFile(join(dir, "structured-scenario"), JSON.stringify({
    updates: [['{"answer":"ok"}', "final"]],
    stopReason: "max_tokens",
  }));
  const { session } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await expect(control.ask(session, { prompt: promptFromText("ask"), schema: z.object({ answer: z.string() }) }))
    .rejects.toThrow(/max_tokens/);
  expect(existsSync(join(dir, "history.log"))).toBe(false);
});

test("a message behind a running turn is queued with the turn it will run as, and runs after it", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const ended: number[] = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      if (event.kind === "turn-ended") {
        ended.push(event.turn);
        if (ended.length === 2) return;
      }
    }
  })();
  const first = await control.send(id, "one");
  const second = await control.send(id, "two");
  expect(first).toMatchObject({ status: "started", turn: 1 });
  expect(second).toMatchObject({ status: "queued", turn: 2 });
  expect(typeof second.at).toBe("number");
  await watching;
  expect(ended).toEqual([1, 2]);
});

test("a message into the running turn of an mcode that serves steer is delivered into it", async () => {
  control = await fakeControl({ steer: true });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const idle = await control.send(id, "one", { into: "turn" });
  expect(idle.status).toBe("started");
  const receipt = await control.send(id, "two", { into: "turn" });
  expect(receipt).toMatchObject({ status: "delivered", turn: 1 });
  const steers = (await readFile(join(dir, "steers.log"), "utf8")).trim().split("\n");
  expect(steers.map((line) => JSON.parse(line))).toEqual([{ sessionId: "fake-1", text: "two" }]);
  // Nothing was queued: the next plain send, after the turn, is the second turn.
  await Bun.sleep(400);
  expect(await control.send(id, "three")).toMatchObject({ status: "started", turn: 2 });
});

test("a message into the running turn of an mcode without steer is queued, never refused", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  expect((await control.send(id, "one", { into: "turn" })).status).toBe("started");
  expect(await control.send(id, "two", { into: "turn" })).toMatchObject({ status: "queued", turn: 2 });
  expect(await Bun.file(join(dir, "steers.log")).exists()).toBe(false);
});

test("a steer that mcode refuses falls through to the queue, once", async () => {
  control = await fakeControl({ steer: true, files: ["steer-refuse"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "one", { into: "turn" });
  expect(await control.send(id, "two", { into: "turn" })).toMatchObject({ status: "queued", turn: 2 });
  expect(await Bun.file(join(dir, "steers.log")).exists()).toBe(false);
});

test("a steer that fails after mcode may have taken it is not sent again and is reported as unknown", async () => {
  control = await fakeControl({ steer: true, files: ["steer-fail"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "one", { into: "turn" });
  await expect(control.send(id, "two", { into: "turn" })).rejects.toMatchObject({ code: "InputPossiblySent" });
  // The steer was the only delivery, and nothing was queued: after the turn the next send runs at once.
  const steers = (await readFile(join(dir, "steers.log"), "utf8")).trim().split("\n");
  expect(steers).toHaveLength(1);
  await Bun.sleep(400);
  expect(await control.send(id, "three")).toMatchObject({ status: "started", turn: 2 });
});

test("a steer that gets no reply is not sent again and is reported as unknown", async () => {
  control = await fakeControl({ steer: true, files: ["steer-hang"], callTimeoutMs: 1_000 });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "one", { into: "turn" });
  await expect(control.send(id, "two", { into: "turn" })).rejects.toMatchObject({ code: "InputPossiblySent" });
  // Nothing was queued: after the turn the next send is the second turn, and runs at once.
  await Bun.sleep(1_100);
  expect(await control.send(id, "three")).toMatchObject({ status: "started", turn: 2 });
});

test("malformed extension meta in the initialize reply means no steer, and no throw", () => {
  expect(servesSteer({ _meta: "x" })).toBe(false);
  expect(servesSteer({ _meta: { "minimax-code/extensions": { methods: "mcode/session/steer" } } })).toBe(false);
  expect(servesSteer({ _meta: { "minimax-code/extensions": null } })).toBe(false);
  expect(servesSteer({})).toBe(false);
  expect(servesSteer({ _meta: { "minimax-code/extensions": { version: 1, methods: ["mcode/session/queue/list"], notifications: [] } } })).toBe(false);
  expect(servesSteer({ _meta: { "minimax-code/extensions": { version: 1, methods: ["mcode/session/steer"], notifications: [] } } })).toBe(true);
});

test("an interrupt of a session with no running turn is refused", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await expect(control.interrupt(id)).rejects.toThrow("no turn is running");
});

test("a child that dies in the first turn: the start has returned, and the stream of life ends", async () => {
  control = await fakeControl();
  const { session: id, first } = await control.start({ prompt: promptFromText("die"), cwd: dir });
  expect(first).toMatchObject({ status: "started", turn: 1 });
  // The death is a sign of life, not a failure of the start: the first stream sees the turn
  // begin, and then the session is over.
  const events: LifeEvent[] = [];
  for await (const event of control.life(id)) events.push(event);
  expect(events[0]).toMatchObject({ kind: "turn-started", turn: 1 });
  expect(await control.state(id)).toBe("unknown");
});

test("the start returns before the first turn ends: a first turn that never ends does not block it", async () => {
  control = await fakeControl();
  const { session: id, first } = await control.start({ prompt: promptFromText("hang"), cwd: dir });
  expect(id.native).toBe("fake-1" as typeof id.native);
  // The prompt became the first turn, delivered like a send; it is still running.
  expect(first).toMatchObject({ status: "started", turn: 1 });
  expect(await control.state(id)).toBe("running");
  // The first stream of life is given the start of that turn, which began before it existed.
  const iterator = control.life(id)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ kind: "turn-started", turn: 1 });
  void iterator.return?.();
  // The session takes messages at once: they wait behind the first turn.
  expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
});

test("a question on a busy session waits behind the running turn and is answered after it", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText("one"), cwd: dir });
  const ended: number[] = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      if (event.kind !== "turn-ended") continue;
      ended.push(event.turn);
      if (ended.length === 3) return;
    }
  })();
  expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  const answer = await control.ask(id, {
    schema: z.object({ word: z.string() }),
    prompt: promptFromText("give the word"),
  });
  expect(answer.value.word).toBe("ok");
  await watching;
  // One turn after the other: the start's turn, the message, then the question.
  expect(ended).toEqual([1, 2, 3]);
});

test("a start or a resume that switches tools off is refused by name: mcode has no switch for them", async () => {
  control = await fakeControl();
  await expect(
    control.start({ prompt: promptFromText(""), cwd: dir, visible: { actions: [], disabledTools: ["shell"] } }),
  ).rejects.toMatchObject({ code: "Unsupported" });
  await expect(
    control.resume(sessionId(harnessId("mcode"), "nope"), { visible: { actions: [], disabledTools: ["shell"] } }),
  ).rejects.toMatchObject({ code: "Unsupported" });
  // No child was asked for a session.
  expect(existsSync(join(dir, "sessions.log"))).toBe(false);
});

test("a start or a resume with a tool allowance is refused by name: mcode's ACP has no tool flag", async () => {
  control = await fakeControl();
  await expect(
    control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["Read"] } }),
  ).rejects.toMatchObject({ code: "Unsupported" });
  await expect(
    control.resume(sessionId(harnessId("mcode"), "nope"), { tools: { allow: [] } }),
  ).rejects.toMatchObject({ code: "Unsupported" });
  expect(existsSync(join(dir, "sessions.log"))).toBe(false);
});

const ISOLATED_ARGV = ["acp", "--no-builtin-tools", "--session-mcp-only"];
const TOOL_HELP = "Options:\n  --no-builtin-tools    Disable native tools\n  --session-mcp-only    Use the client's MCP servers\n";

test("the registry advertises isolation only for a fork executable with both ACP flags", async () => {
  control = await fakeControl({ lineage: "fork" });
  const binary = join(dir, "mcode");
  const kinds = new HarnessKindRegistry();
  kinds.register(ncodeKind);
  kinds.register(mcodeKind);
  expect(ncodeKind.capabilities.control.tools.niwaOnly).toMatchObject({ supported: true, status: "admitted" });
  expect(ncodeKind.capabilities.control.tools.allow).toMatchObject({ supported: true, status: "admitted" });
  expect(mcodeKind.capabilities.control.tools.niwaOnly.supported).toBe(false);
  expect(mcodeKind.capabilities.control.tools.allow.supported).toBe(false);

  const installations = new HarnessInstanceRegistry(kinds);
  for (const [harness, help, supported] of [
    ["old-fork", "", false],
    ["one-flag", "  --no-builtin-tools\n  mention --session-mcp-only in a description\n", false],
    ["new-fork", TOOL_HELP, true],
  ] as const) {
    await writeFile(join(dir, "tool-help"), help);
    const bound = ncodeKind.bind({ id: harness, control: { binary } });
    installations.register(bound);
    // The exact tool set rides the ACP capability for every fork launcher: a binary too old
    // for it is refused by name when a session asks for one, never left with tools on silently.
    expect(installations.resolve(harness).sides.control?.tools).toEqual({ niwaOnly: supported, allow: true });
    if (!supported) {
      await expect(bound.control!.start({ prompt: promptFromText(""), cwd: dir, tools: "niwa-only" }))
        .rejects.toMatchObject({ code: "Unsupported" });
      await expect(bound.control!.resume(sessionId(harnessId(harness), "fake-1"), { cwd: dir, tools: "niwa-only" }))
        .rejects.toMatchObject({ code: "Unsupported" });
    }
  }
  const upstream = mcodeKind.bind({ id: "upstream", control: { binary } });
  installations.register(upstream);
  expect(installations.resolve("upstream").sides.control?.tools).toEqual({ niwaOnly: false, allow: false });
  await expect(upstream.control!.start({ prompt: promptFromText(""), cwd: dir, tools: "niwa-only" }))
    .rejects.toMatchObject({ code: "Unsupported" });
  await expect(upstream.control!.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read"] } }))
    .rejects.toMatchObject({ code: "Unsupported" });
  await expect(upstream.control!.resume(sessionId(harnessId("upstream"), "fake-1"), { cwd: dir, tools: "niwa-only" }))
    .rejects.toMatchObject({ code: "Unsupported" });
  expect(existsSync(join(dir, "argv.log"))).toBe(false);
});

test("an isolated fork starts and cold-resumes with both gates and the supplied MCP servers", async () => {
  control = await fakeControl({ lineage: "fork" });
  await writeFile(join(dir, "tool-help"), TOOL_HELP);
  const servers = [{ name: "niwa", command: "bun", args: ["mcp"], env: {} }];
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: "niwa-only", servers });
  await control.resume(id); // Warm with no mode keeps the existing policy.
  await expect(control.resume(id, { tools: "all" })).rejects.toMatchObject({ code: "Unsupported" });
  await control.stop(id);
  await control.resume(id, { cwd: dir, tools: "niwa-only", servers });
  expect(await argvOf()).toEqual([ISOLATED_ARGV, ISOLATED_ARGV]);
  const sessions = await sessionRequestsOf();
  expect(sessions[0]?.mcpServers).toMatchObject(servers.map(({ name, command, args }) => ({ name, command, args })));
  expect(sessions[1]?.mcpServers).toMatchObject(servers.map(({ name, command, args }) => ({ name, command, args })));
  await control.stop(id);
  await writeFile(join(dir, "tool-help"), "");
  await expect(control.resume(id, { cwd: dir, tools: "niwa-only" })).rejects.toMatchObject({ code: "Unsupported" });
  expect(await argvOf()).toHaveLength(2);
});

test("a fork start with a tool allowance sends the policy in the session _meta", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read", "bash"] } });
  const meta = (await sessionRequestsOf())[0]?._meta as Record<string, unknown>;
  expect(meta).toMatchObject({
    "minimax-code/permissionMode": "bypassPermissions",
    "minimax-code/toolPolicy": { allow: ["read", "bash"] },
  });
  // The empty allowance is valid on the wire: no built-in tool at all.
  const second = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: [] } });
  expect(((await sessionRequestsOf())[1]?._meta as Record<string, unknown>)["minimax-code/toolPolicy"]).toEqual({ allow: [] });
  await control.stop(second);
  await control.stop(id);
});

test("a cold resume that names no mode re-sends the session's own tool policy", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read", "bash"] } });
  await control.stop(id);
  // Omission is not widening: the process is new, the policy is the session's own.
  await control.resume(id, { cwd: dir });
  const sessions = await sessionRequestsOf();
  expect(sessions[1]?.["sessionId"]).toBe("fake-1");
  expect((sessions[1]?._meta as Record<string, unknown>)["minimax-code/toolPolicy"]).toEqual({ allow: ["read", "bash"] });
});

test("a cold resume re-binds an explicitly named tool policy on session/load", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read"] } });
  await control.stop(id);
  await control.resume(id, { cwd: dir, tools: { allow: ["read"] } });
  const sessions = await sessionRequestsOf();
  expect(sessions[1]?.["sessionId"]).toBe("fake-1");
  expect((sessions[1]?._meta as Record<string, unknown>)["minimax-code/toolPolicy"]).toEqual({ allow: ["read"] });
});

test("a warm resume cannot change the tool mode of a running ncode process", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read", "bash"] } });
  // The same allowance stays, whatever its order; another one is refused.
  await control.resume(id, { tools: { allow: ["bash", "read"] } });
  await expect(control.resume(id, { tools: { allow: ["read"] } })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { tools: { allow: ["read", "bash", "grep"] } })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { tools: "all" })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { tools: "niwa-only" })).rejects.toMatchObject({ code: "Unsupported" });
  await control.stop(id);
});

test("the fork's own tool listing answers through mcode/session/tools", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read"] } });
  const tools = await control.toolsOf(id);
  expect(tools.policy).toEqual({ mode: "allow", allow: ["read"], servers: [] });
  expect(tools.catalog).toEqual([
    { name: "read", source: "builtin" },
    { name: "bash", source: "builtin" },
  ]);
  expect(tools.effective).toEqual(["read"]);
  expect(await readFile(join(dir, "tools.log"), "utf8")).toContain("fake-1");
  await control.stop(id);
});

test("a start fails when the agent does not hold the session to its tool policy", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method", "ignore-policy"] });
  await expect(
    control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read"] } }),
  ).rejects.toMatchObject({
    code: "Unavailable",
    message: expect.stringContaining("did not hold the session to its tool policy"),
  });
});

test("a cold resume cannot change the exact tool mode a session was started with", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read", "bash"] } });
  await control.stop(id);
  await expect(control.resume(id, { cwd: dir, tools: "all" })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { cwd: dir, tools: { allow: ["read"] } })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { cwd: dir, tools: "niwa-only" })).rejects.toMatchObject({ code: "Unsupported" });
});

test("a session asked to run plain keeps its exact tool set, and no box is asked for", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method"] });
  // `box: false` is a launch that names no box: the process is the host's own, at the start and
  // at each cold resume alike, and the tool set rides beside it.
  const launches: Array<string | undefined> = [];
  const unlisten = onSpawn((event) => {
    if (event.harness === harnessId("mcode-fake")) launches.push(event.sandbox);
  });
  try {
    const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["read"] } });
    await control.stop(id);
    await control.resume(id, { cwd: dir });
    await expect(control.resume(id, { tools: "all" })).rejects.toMatchObject({ code: "Unsupported" });
    expect(launches).toEqual([undefined, undefined]);
    const policies = (await sessionRequestsOf()).map(
      (request) => (request._meta as Record<string, unknown>)["minimax-code/toolPolicy"],
    );
    expect(policies).toEqual([{ allow: ["read"] }, { allow: ["read"] }]);
    expect((await control.toolsOf(id)).policy).toEqual({ mode: "allow", allow: ["read"], servers: [] });
    await control.stop(id);
  } finally {
    unlisten();
  }
});

/**
 * A stand-in for `ps`, first on PATH: it answers an empty table and writes down that it was
 * asked, so a test can tell whether a stop went looking for marked processes without the real
 * process list. Returns the log and what takes the stand-in off PATH again.
 */
async function psOnPath(): Promise<{ readonly log: string; readonly restore: () => void }> {
  const own = await tempDir("ps-stand-in");
  const log = join(own, "ps.log");
  await writeFile(join(own, "ps"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  await chmod(join(own, "ps"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${own}${delimiter}${path}`;
  return { log, restore: () => void (process.env.PATH = path) };
}

test("an upstream stop still looks for the MCP processes of a session, servers given or none", async () => {
  control = await fakeControl({ lineage: "upstream" });
  const { log, restore } = await psOnPath();
  try {
    const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
    await control.stop(id);
    expect(await readFile(log, "utf8")).toContain("eww -ax -o pid=,command=");
  } finally {
    restore();
  }
});

test("a fork stop looks for the MCP processes only when the session was given a server", async () => {
  control = await fakeControl({ lineage: "fork" });
  const { log, restore } = await psOnPath();
  try {
    const bare = await control.start({ prompt: promptFromText(""), cwd: dir });
    await control.stop(bare.session);
    expect(existsSync(log)).toBe(false);
    // The same stand-in does answer once the fork has a server to find: the check above was not
    // a stand-in that never could.
    const served = await control.start({
      prompt: promptFromText(""), cwd: dir,
      servers: [{ name: "niwa", command: "bun", args: ["mcp"], env: {} }],
    });
    await control.stop(served.session);
    expect(await readFile(log, "utf8")).toContain("eww -ax -o pid=,command=");
  } finally {
    restore();
  }
});

test("the fork's refusal of an unknown tool name fails the start", async () => {
  control = await fakeControl({ lineage: "fork", files: ["tools-method", "refuse-tools-unknown"] });
  await expect(
    control.start({ prompt: promptFromText(""), cwd: dir, tools: { allow: ["no_such_tool"] } }),
  ).rejects.toMatchObject({
    code: "Unavailable",
    message: expect.stringContaining("unknown tool names"),
  });
});

test("the isolation probe uses the host launcher and never the session cwd or environment", async () => {
  control = await fakeControl({ lineage: "fork" });
  // The fixture's interpreter is independent of PATH. Check the actual environment below.
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT.replace("#!/usr/bin/env bun", `#!${process.execPath}`));
  await writeFile(join(dir, "tool-help"), TOOL_HELP);
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "fork"), "");
  const guestPath = join(workspace, "bin");
  const started = await control.start({
    prompt: promptFromText(""), cwd: workspace, tools: "niwa-only",
    env: { PATH: guestPath, NIWA_ID: "session-marker", PROBE_SENTINEL: "session-owned", NODE_OPTIONS: "--no-warnings" },
  });
  const probes = (await readFile(join(dir, "probe.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const selected = (await readFile(join(workspace, "argv.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(probes).toEqual([{
    cwd: await realpath(dir),
    path: expect.not.stringContaining(guestPath), sessionEnv: false, nodeOptions: false, sentinel: false,
  }]);
  expect(selected).toEqual([ISOLATED_ARGV]);
  expect(await control.state(started.session)).toBe("idle");
});

test("an all-tools fork receives no isolation flags and cannot be warm-restricted", async () => {
  control = await fakeControl({ lineage: "fork" });
  await writeFile(join(dir, "tool-help"), TOOL_HELP);
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, tools: "all" });
  await expect(control.resume(id, { tools: "niwa-only" })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.resume(id, { tools: { allow: [] } })).rejects.toMatchObject({ code: "Unsupported" });
  await expect(control.start({ cwd: dir, prompt: promptFromText(""), tools: "niwa-only", visible: { actions: [], disabledTools: ["shell"] } }))
    .rejects.toMatchObject({ code: "Unsupported" });
  await control.stop(id);
  await control.resume(id, { cwd: dir, tools: "all" });
  expect(await argvOf()).toEqual([["acp"], ["acp"]]);
});

for (const first of ["all", "niwa-only"] as const) {
  test(`parallel cold resumes with different policies cannot share the ${first} process`, async () => {
    control = await fakeControl({ lineage: "fork" });
    await writeFile(join(dir, "tool-help"), TOOL_HELP);
    const id = sessionId(harnessId("mcode-fake"), "fake-1");
    const other = first === "all" ? "niwa-only" : "all";
    const results = await Promise.allSettled([
      control.resume(id, { cwd: dir, tools: first }),
      control.resume(id, { cwd: dir, tools: other }),
    ]);
    expect(results).toMatchObject([{ status: "fulfilled" }, { status: "rejected", reason: { code: "Unsupported" } }]);
    expect(await argvOf()).toEqual([first === "all" ? ["acp"] : ISOLATED_ARGV]);
  });
}

test("every mcode session is a process of its own, in process mode, with the environment of its session", async () => {
  control = await fakeControl();
  await control.start({ prompt: promptFromText(""), cwd: dir, env: { NIWA_ID: "one" } });
  await control.start({ prompt: promptFromText(""), cwd: dir, env: { NIWA_ID: "two" } });
  const lines = (await readFile(join(dir, "env.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { mode: "off", id: "one" },
    { mode: "off", id: "two" },
  ]);
});

test("the MCP servers of a start are the mcpServers of the session, with the environment as pairs", async () => {
  control = await fakeControl();
  await control.start({
    prompt: promptFromText(""),
    cwd: dir,
    servers: [
      {
        name: "niwa",
        command: "bun",
        args: ["bin/niwa.ts", "mcp"],
        env: { NIWA_VISIBLE: "session.send" },
      },
    ],
  });

  const requests = await sessionRequestsOf();
  expect(requests).toHaveLength(1);
  // The environment of the server is the one niwa named, and one more: the mark by which a stop
  // finds the server, which mcode starts outside the group of the agent.
  const servers = requests[0]?.["mcpServers"] as Array<{ env: Array<{ name: string; value: string }> }>;
  expect(servers).toHaveLength(1);
  expect(servers[0]).toMatchObject({ name: "niwa", command: "bun", args: ["bin/niwa.ts", "mcp"] });
  expect(servers[0]?.env.find((entry) => entry.name === "NIWA_VISIBLE")?.value).toBe("session.send");
  expect(servers[0]?.env.find((entry) => entry.name === "NIWA_MCP_OWNER")?.value).toMatch(/^[0-9a-f-]{36}$/);
});

test("a session with no MCP servers is asked for with no servers", async () => {
  control = await fakeControl();
  await control.start({ prompt: promptFromText(""), cwd: dir });

  const requests = await sessionRequestsOf();
  expect(requests[0]?.["mcpServers"]).toEqual([]);
});

test("close stops the process of the session, as the contract's release", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  expect(await control.state(id)).not.toBe("unknown");
  await control.close!(id);
  expect(await control.state(id)).toBe("unknown");
});

test("a stop also stops the MCP servers the session was given, wherever the agent started them", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({
    prompt: promptFromText(""),
    cwd: dir,
    servers: [{ name: "niwa", command: "bun", args: ["bin/niwa.ts", "mcp"], env: {} }],
  });
  const requests = await sessionRequestsOf();
  const servers = requests[0]?.["mcpServers"] as Array<{ env: Array<{ name: string; value: string }> }>;
  const mark = servers[0]?.env.find((entry) => entry.name === "NIWA_MCP_OWNER")?.value ?? "";
  expect(mark).not.toBe("");

  // What mcode does: a server of the session, in a process group of its own, not the agent's child.
  const server = Bun.spawn(["sleep", "300"], {
    env: { ...process.env, NIWA_MCP_OWNER: mark },
    stdio: ["ignore", "ignore", "ignore"],
  });
  // A server of another session carries another mark and is left alone.
  const other = Bun.spawn(["sleep", "300"], {
    env: { ...process.env, NIWA_MCP_OWNER: "00000000-0000-0000-0000-000000000000" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await control.stop(id);
    await Promise.race([server.exited, Bun.sleep(5_000)]);
    expect(server.killed || server.exitCode !== null || server.signalCode !== null).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  } finally {
    other.kill();
    server.kill();
  }
});

test("a session is resumed by a new process: session/load names no session, and the id stays the same", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  // The process of the session dies with its host; the next control side loads it from disk.
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  expect(await control.state(id)).toBe("unknown");
  // The fake writes its log in its working directory, and a resumed process starts in ours.
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  const requests = await sessionRequestsOf();
  expect(requests[1]?.["sessionId"]).toBe(id.native);
  expect(await control.state(id)).toBe("idle");
});

test("a resumed session whose turn outlived its process is busy: a question waits behind that turn, and no prompt goes in while it runs", async () => {
  control = await fakeControl({ files: ["status"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  // The daemon runs on the turn of the process that died.
  await writeFile(join(dir, "foreign-turn"), "");
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  expect(await control.state(id)).toBe("running");
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      if (event.kind === "activity") continue;
      events.push(event);
      if (events.length === 4) return;
    }
  })();
  const asked = control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  // The question waits behind the turn that runs: a send says so.
  expect(await control.send(id, "after")).toMatchObject({ status: "queued", turn: 3 });
  await Bun.sleep(1_200);
  expect(await control.state(id)).toBe("running");
  // The turn that outlived its process ends; then the question goes out and is answered.
  await rm(join(dir, "foreign-turn"));
  const answer = await asked;
  expect(answer.value.word).toBe("ok");
  await watching;
  expect(events.map((event) => [event.kind, "turn" in event ? event.turn : undefined])).toEqual([
    ["turn-started", 1],
    ["turn-ended", 1],
    ["turn-started", 2],
    ["turn-ended", 2],
  ]);
  const statuses = (await readFile(join(dir, "status.log"), "utf8")).trim().split("\n");
  expect(statuses[0]).toBe("busy");
  expect(statuses.at(-1)).toBe("idle");
});

test("a cancelled turn the agent does not let go of stays running: what waits goes out only once the agent says no turn is active", async () => {
  control = await fakeControl({ files: ["status", "deaf"], turnTimeoutMs: 600, cancelGraceMs: 500 });
  const { session: id } = await control.start({ prompt: promptFromText("hang"), cwd: dir });
  const details: string[] = [];
  void (async () => {
    for await (const event of control.life(id)) if (event.kind === "activity") details.push(event.detail ?? "");
  })();
  const asked = control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  // Past the turn time and the grace of the cancel: the agent still holds the turn.
  await eventually(() => details.includes("the cancelled turn was not let go: it is followed"), 10_000);
  expect(await control.state(id)).toBe("running");
  // The agent lets the turn go; the question goes out after it and is answered.
  await writeFile(join(dir, "release"), "");
  const answer = await asked;
  expect(answer.value.word).toBe("ok");
  // The turn that was cut off for its time did not end well: it is said to have failed.
  expect(details.some((detail) => detail.includes("the turn failed: the turn did not end in time"))).toBe(true);
});

test("a turn the agent never lets go of, not even after its cancel, fails what waits behind it and still takes no prompt", async () => {
  control = await fakeControl({ files: ["status", "deaf"], turnTimeoutMs: 300, cancelGraceMs: 1_000 });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  // The daemon holds a turn for a client that is gone, and never lets it go.
  await writeFile(join(dir, "foreign-turn"), "");
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  const startedAt = Date.now();
  let failure: unknown;
  try {
    await control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  } catch (error) {
    failure = error;
  }
  // The question is told which turn holds the session, inside the turn time and the grace; it
  // never went in, so the agent did not refuse it.
  expect(String(failure)).toMatch(/holds turn "t0"/);
  expect(String(failure)).not.toMatch(/local_session_busy/);
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(await control.state(id)).toBe("running");
});

test("a resumed session with no active turn is idle, and a resume prompt runs as its turn", async () => {
  control = await fakeControl({ files: ["status"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  expect(await control.state(id)).toBe("idle");
});

test("a resume with a prompt into a session whose turn outlived its process waits behind that turn", async () => {
  control = await fakeControl({ files: ["status"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  await writeFile(join(dir, "foreign-turn"), "");
  setTimeout(() => void rm(join(dir, "foreign-turn")), 1_000);
  const here = process.cwd();
  process.chdir(dir);
  try {
    // Refused with "local_session_busy" if it went in while the turn ran.
    await control.resume(id, { prompt: promptFromText("two") });
  } finally {
    process.chdir(here);
  }
  expect(await control.state(id)).toBe("idle");
});

test("a question behind a turn of ours that the agent holds past its cancel fails once the grace is over, not a second grace later", async () => {
  control = await fakeControl({ files: ["status", "deaf"], turnTimeoutMs: 300, cancelGraceMs: 2_000 });
  const { session: id } = await control.start({ prompt: promptFromText("hang"), cwd: dir });
  const startedAt = Date.now();
  let failure: unknown;
  try {
    await control.ask(id, { schema: z.object({ word: z.string() }), prompt: promptFromText("give the word") });
  } catch (error) {
    failure = error;
  }
  const waited = Date.now() - startedAt;
  expect(String(failure)).toMatch(/holds turn "t0"/);
  // The cancel went at 0.3 s and the grace ended at 2.3 s: the next poll says so, and that is
  // well before a second grace would be over (4.3 s), with room for a loaded machine.
  expect(waited).toBeLessThan(3_600);
  expect(await control.state(id)).toBe("running");
}, 15_000);

/** Resume a session whose process died, from the directory of the fake agent. */
async function resumeDead(control: McodeSessionControl, options: { prompt?: string; foreignTurn?: boolean } = {}): Promise<SessionId> {
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  if (options.foreignTurn === true) await writeFile(join(dir, "foreign-turn"), "");
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id, options.prompt === undefined ? undefined : { prompt: promptFromText(options.prompt) });
  } finally {
    process.chdir(here);
  }
  return id;
}

test("an agent that does not advertise the turn status is never asked for it: a resume goes on as it did", async () => {
  control = await fakeControl();
  // A turn the daemon holds, which an agent without the status cannot tell of.
  const id = await resumeDead(control, { foreignTurn: true });
  expect(await control.state(id)).toBe("idle");
  expect(existsSync(join(dir, "status.log"))).toBe(false);
});

test("an agent that advertises the turn status and fails it is resumed as if it had none: no throw, no turn assumed", async () => {
  control = await fakeControl({ files: ["status", "status-error"] });
  const id = await resumeDead(control, { prompt: "two" });
  expect(await control.state(id)).toBe("idle");
  expect((await readFile(join(dir, "status.log"), "utf8")).trim().split("\n")).toEqual(["error"]);
});

test("a turn that is followed is no longer asked about once the control side is disposed", async () => {
  control = await fakeControl({ files: ["status"] });
  const id = await resumeDead(control, { foreignTurn: true });
  expect(await control.state(id)).toBe("running");
  await Bun.sleep(1_200);
  await control.dispose();
  // A poll that was in flight when the child went may still land: let it.
  await Bun.sleep(700);
  const asked = (await readFile(join(dir, "status.log"), "utf8")).trim().split("\n").length;
  expect(asked).toBeGreaterThan(1);
  await Bun.sleep(1_500);
  expect((await readFile(join(dir, "status.log"), "utf8")).trim().split("\n")).toHaveLength(asked);
  expect(await control.state(id)).toBe("unknown");
}, 15_000);

for (const [named, accepted] of [
  ["fake-1", true],
  ["another", false],
] as const) {
  test(`a session/load that names ${named === "fake-1" ? "the same" : "another"} session is ${accepted ? "taken" : "refused"}`, async () => {
    control = await fakeControl();
    const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
    await control.send(id, "die");
    for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
    await writeFile(join(dir, "load-id"), named);
    // The fake reads its files in its working directory, and a resumed process starts in ours.
    const here = process.cwd();
    process.chdir(dir);
    let failure: unknown;
    try {
      await control.resume(id);
    } catch (error) {
      failure = error;
    } finally {
      process.chdir(here);
    }
    if (accepted) {
      expect(failure).toBeUndefined();
      expect(await control.state(id)).toBe("idle");
    } else {
      expect(String(failure)).toMatch(/another session/);
      expect(await control.state(id)).toBe("unknown");
    }
  });
}

/** The arguments every spawn of the fake agent was given. */
const argvOf = async (): Promise<string[][]> =>
  (await readFile(join(dir, "argv.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

async function fakeKind(
  options: { profile?: string; home?: string; control?: { profile?: string } },
  make: typeof mcode | typeof ncode = mcode,
) {
  dir = await tempDir("mcode-profile");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  if (make === ncode) await writeFile(join(dir, "fork"), "");
  const kind = make({ home: join(dir, "home"), ...options, control: { mode: "full", ...options.control, binary } });
  control = kind.control as McodeSessionControl;
  await control.start({ prompt: promptFromText(""), cwd: dir });
  return argvOf();
}

test("without a profile the regular harness is started without one", async () => {
  expect(await fakeKind({})).toEqual([["acp"]]);
});

test("upstream is never given an implicit --profile, even when its home holds a durable history", async () => {
  dir = await tempDir("mcode-upstream-durable");
  const home = join(dir, "home");
  await mkdir(join(home, "durable-history"), { recursive: true });
  await writeFile(join(home, "durable-history", "sessions.g1.db"), "");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  const kind = mcode({ home, control: { mode: "full", binary } });
  control = kind.control as McodeSessionControl;
  await control.start({ prompt: promptFromText(""), cwd: dir });
  expect(await argvOf()).toEqual([["acp"]]);
});

test("without a profile the fork (a home with a durable history) is started with --profile default", async () => {
  dir = await tempDir("mcode-fork");
  const forkHome = join(dir, "home");
  await mkdir(join(forkHome, "durable-history"), { recursive: true });
  await writeFile(join(forkHome, "durable-history", "sessions.g1.db"), "");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  await writeFile(join(dir, "fork"), "");
  const kind = ncode({ home: forkHome, control: { mode: "full", binary } });
  control = kind.control as McodeSessionControl;
  await control.start({ prompt: promptFromText(""), cwd: dir });
  expect(await argvOf()).toEqual([["acp", "--profile", "default"]]);
});

test("the profile of the kind is the profile the agent is started with", async () => {
  expect(await fakeKind({ profile: "work" }, ncode)).toEqual([["acp", "--profile", "work"]]);
});

test("a profile named in the control options is the profile of the kind", async () => {
  expect(await fakeKind({ control: { profile: "work" } }, ncode)).toEqual([["acp", "--profile", "work"]]);
});

test("an explicit home and a profile are both kept", async () => {
  const argv = await fakeKind({ home: "/somewhere/else", profile: "work" }, ncode);
  expect(argv).toEqual([["acp", "--profile", "work"]]);
});

test("the published build has no --profile: a start or a resume that names a profile is refused before a process is run", async () => {
  dir = await tempDir("mcode-profile");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  for (const kind of [mcode({ home: join(dir, "home"), profile: "work", control: { mode: "full", binary } })]) {
    control = kind.control as McodeSessionControl;
    await expect(control.start({ prompt: promptFromText(""), cwd: dir })).rejects.toMatchObject({ code: "Unsupported" });
    await expect(control.resume(sessionId(harnessId("mcode"), "mvs_x"))).rejects.toMatchObject({ code: "Unsupported" });
    expect(existsSync(join(dir, "argv.log"))).toBe(false);
  }
  // The fork takes it, and so does an upstream build that names none.
  expect(await fakeKind({ profile: "work" }, ncode)).toEqual([["acp", "--profile", "work"]]);
});

test("the home follows the profile: default is ~/.minimax, any other is ~/.minimax-<profile>", () => {
  expect(homeNameOfProfile(undefined)).toBe(".minimax");
  expect(homeNameOfProfile("default")).toBe(".minimax");
  expect(homeNameOfProfile("work")).toBe(".minimax-work");
});

test("the home of a profile is under the given base", () => {
  expect(homeOfProfile("work", "/h")).toBe("/h/.minimax-work");
  expect(homeOfProfile(undefined, "/h")).toBe("/h/.minimax");
});

test("a turn over its time is cancelled, and what waited behind it goes out only after the agent let the turn go", async () => {
  control = await fakeControl({ turnTimeoutMs: 300 });
  const { session: id } = await control.start({ prompt: promptFromText("hang"), cwd: dir });
  const events: LifeEvent[] = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      events.push(event);
      if (event.kind === "turn-ended" && event.turn === 2) return;
    }
  })();
  expect(await control.send(id, "two")).toMatchObject({ status: "queued", turn: 2 });
  await watching;
  const details = events.flatMap((event) => (event.kind === "activity" && event.detail !== undefined ? [event.detail] : []));
  // The first turn was cancelled for its time and failed; the message behind it was not sent as a
  // second prompt at once, so the agent took it and ended it.
  expect(details).toContain("the turn did not end in time: it was cancelled");
  expect(details).toContain("the turn failed: the turn did not end in time");
  expect(details.some((detail) => detail.includes("already active"))).toBe(false);
  expect(await control.state(id)).toBe("idle");
});

test("an effort is the thinkingEffort option of that session, set after the model; the model is not an argument of the process", async () => {
  control = await fakeControl();
  await control.start({ prompt: promptFromText(""), cwd: dir, model: "minimax/MiniMax-M3.1-Flash", effort: "xhigh" });

  expect(await configCallsOf()).toEqual([
    { sessionId: "fake-1", configId: "permissionMode", value: "bypassPermissions" },
    { sessionId: "fake-1", configId: "model", value: "m:minimax:MiniMax-M3.1-Flash:u" },
    { sessionId: "fake-1", configId: "thinkingEffort", value: "xhigh" },
  ]);
  expect((await readFile(join(dir, "argv.log"), "utf8")).trim()).toBe(JSON.stringify(["acp"]));
});

test("the model the agent lists as current after the options are applied is a sign of life, and a resume asks for exactly that value", async () => {
  control = await fakeControl({ files: ["reports-model"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, model: "minimax/MiniMax-M3.1-Flash#thinking" });
  // The agent names the model the way it keeps it, an option value, not the id the start asked for.
  const named = await firstModel(control, id);
  expect(named).toBe(modelName("m:minimax:MiniMax-M3.1-Flash:v:thinking"));

  // The process dies, and the session is taken on again by a new one, which is asked for the model that was named.
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id, { model: named });
  } finally {
    process.chdir(here);
  }
  expect((await configCallsOf()).filter((call) => call["configId"] === "model").map((call) => call["value"])).toEqual([
    "m:minimax:MiniMax-M3.1-Flash:v:thinking",
    "m:minimax:MiniMax-M3.1-Flash:v:thinking",
  ]);
  expect(await firstModel(control, id)).toBe(named);
});

test("an agent that does not list its options names no model, and nothing is taken for one", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText("one"), cwd: dir, model: "minimax/MiniMax-M3.1-Flash" });
  const seen: LifeEvent[] = [];
  for await (const event of control.life(id)) {
    seen.push(event);
    if (event.kind === "turn-ended") break;
  }
  expect(seen.filter((event) => event.kind === "model")).toEqual([]);
});

/** The first model the first stream of life names. */
async function firstModel(side: McodeSessionControl, id: SessionId): Promise<ModelName | undefined> {
  for await (const event of side.life(id)) {
    if (event.kind === "model") return event.model;
  }
  return undefined;
}

for (const lineage of ["upstream", "fork"] as const) {
  test(`${lineage}: a working mode is the permissionMode of the session: ask is default, auto is auto, full is bypassPermissions`, async () => {
    control = await fakeControl({ lineage });
    for (const mode of ["ask", "auto", "full"] as const) {
      expect((await control.start({ prompt: promptFromText(""), cwd: dir, mode })).mode).toBe(mode);
    }
    expect((await configCallsOf()).map((call) => [call["configId"], call["value"]])).toEqual([
      ["permissionMode", "default"],
      ["permissionMode", "auto"],
      ["permissionMode", "bypassPermissions"],
    ]);
  });

  test(`${lineage}: the instance's own mode is the default of its sessions, and auto when it names none`, async () => {
    dir = await tempDir("mcode-fake");
    const binary = join(dir, "mcode");
    await writeFile(binary, FAKE_AGENT);
    await chmod(binary, 0o755);
    if (lineage === "fork") await writeFile(join(dir, "fork"), "");
    control = mcodeControl({ harness: harnessId("mcode-fake"), binary, lineage });
    expect((await control.start({ prompt: promptFromText(""), cwd: dir })).mode).toBe("auto");
    await control.dispose();

    control = mcodeControl({ harness: harnessId("mcode-fake"), binary, lineage, mode: "ask" });
    expect((await control.start({ prompt: promptFromText(""), cwd: dir })).mode).toBe("ask");
    expect((await configCallsOf()).map((call) => call["value"])).toEqual(["auto", "default"]);
  });
}

test("upstream takes the working mode only through the config option; the fork takes it in session/new as well", async () => {
  control = await fakeControl({ lineage: "upstream" });
  await control.start({ prompt: promptFromText(""), cwd: dir, mode: "auto" });
  const [upstream] = await sessionRequestsOf();
  expect(upstream).not.toHaveProperty("_meta");
  await control.dispose();

  control = await fakeControl({ lineage: "fork" });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, mode: "auto" });
  await control.start({ prompt: promptFromText(""), cwd: dir, mode: "full" });
  const requests = await sessionRequestsOf();
  expect(requests.map((request) => request["_meta"])).toEqual([
    { "minimax-code/permissionMode": "auto" },
    { "minimax-code/permissionMode": "bypassPermissions" },
  ]);
  expect((await configCallsOf()).map((call) => call["value"])).toEqual(["auto", "bypassPermissions"]);

  // A resume names the mode again: the fork opens a loaded session in `default` otherwise.
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id, { mode: "auto" });
    await control.send(id, "die");
    for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  const loaded = (await sessionRequestsOf()).slice(2);
  expect(loaded.map((request) => request["sessionId"])).toEqual(["fake-1", "fake-1"]);
  expect(loaded[0]?.["_meta"]).toEqual({ "minimax-code/permissionMode": "auto" });
  // With no mode named, the session gets the instance's own mode (full here), never the fork's default.
  expect(loaded[1]?.["_meta"]).toEqual({ "minimax-code/permissionMode": "bypassPermissions" });
});

test("upstream sends no _meta on session/load", async () => {
  control = await fakeControl({ lineage: "upstream" });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir, mode: "auto" });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id, { mode: "auto" });
  } finally {
    process.chdir(here);
  }
  expect((await sessionRequestsOf()).at(-1)).not.toHaveProperty("_meta");
});

test("a daemon that cannot take the mode of a session fails the start and the resume with a clear error", async () => {
  control = await fakeControl({ lineage: "fork", files: ["refuse-mode"] });
  const started = await control.start({ prompt: promptFromText(""), cwd: dir }).catch((error: unknown) => error);
  expect(started).toBeInstanceOf(Error);
  expect((started as Error).message).toContain("restart mcoded");
  expect((started as Error).message).toContain("cannot take a permission mode per session");
  // The fake writes its files in its working directory, and a resumed process starts in ours.
  const here = process.cwd();
  process.chdir(dir);
  const resumed = await control
    .resume(sessionId(harnessId("mcode-fake"), "fake-1"))
    .catch((error: unknown) => error)
    .finally(() => process.chdir(here));
  expect(resumed).toBeInstanceOf(Error);
  expect((resumed as Error).message).toContain("restart mcoded");
});

/** What niwa answered to the permission requests the fake agent sent in a turn. */
async function permissionAnswers(
  permissions: "allow" | "deny",
  lineage: MinimaxLineage,
  files: readonly string[] = [],
): Promise<unknown[]> {
  control = await fakeControl({ lineage, permissions, files: ["ask-permission", ...files] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const seen = firstTurnEnded(control.life(id));
  await control.send(id, "go");
  await seen;
  for (let i = 0; i < 100 && !existsSync(join(dir, "permission.log")); i += 1) await Bun.sleep(20);
  return (await readFile(join(dir, "permission.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

for (const lineage of ["upstream", "fork"] as const) {
  test(`${lineage}: a permission request is answered with the one-off option, never a lasting one`, async () => {
    const allowed = await permissionAnswers("allow", lineage);
    expect(allowed.at(-1)).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  test(`${lineage}: a refused permission request picks the one-off reject option`, async () => {
    const denied = await permissionAnswers("deny", lineage);
    expect(denied.at(-1)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  });

  for (const permissions of ["allow", "deny"] as const) {
    test(`${lineage}: when only lasting options are offered, a ${permissions === "allow" ? "granted" : "refused"} request is cancelled`, async () => {
      const answers = await permissionAnswers(permissions, lineage, ["only-always"]);
      expect(answers.at(-1)).toEqual({ outcome: { outcome: "cancelled" } });
    });
  }
}

/** The activity the signs of life of one turn carry. */
async function activityOfTurn(lineage: MinimaxLineage) {
  control = await fakeControl({ lineage, files: ["tool-calls"] });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const seen = firstTurnEnded(control.life(id));
  await control.send(id, "go");
  return (await seen).flatMap((event) => (event.kind === "activity" ? [event] : []));
}

test("the fork's permission mark on a tool call is a sign of life with the decision, as it was said, without its free-text reason", async () => {
  const marked = (await activityOfTurn("fork")).filter((event) => event.permission !== undefined);
  expect(marked.map((event) => [event.detail, event.permission])).toEqual([
    ["tool_call", { decision: "allow", decidedBy: "classifier", ruleKind: null, mode: "auto" }],
    ["tool_call", { decision: "deny", decidedBy: "rule", ruleKind: "builtin", mode: "default" }],
    // An older build sends no ruleKind: it reads as null.
    ["tool_call", { decision: "allow", decidedBy: "mode", ruleKind: null, mode: "bypassPermissions" }],
  ]);
});

test("a tool call of the fork with a mark that is not of the shape, or with none, is plain activity", async () => {
  const toolCalls = (await activityOfTurn("fork")).filter((event) => event.detail?.startsWith("tool_call"));
  // c1 marked, its update unmarked, c2 malformed, c3 and c4 marked.
  expect(toolCalls.map((event) => event.permission?.decidedBy)).toEqual(["classifier", undefined, undefined, "rule", "mode"]);
});

test("upstream does not read the permission mark", async () => {
  const toolCalls = (await activityOfTurn("upstream")).filter((event) => event.detail?.startsWith("tool_call"));
  expect(toolCalls).toHaveLength(5);
  expect(toolCalls.every((event) => event.permission === undefined)).toBe(true);
});

test("a binary that cannot run names itself in the failure", async () => {
  dir = await tempDir("mcode-fake");
  const binary = join(dir, "ncode-broken");
  await writeFile(binary, "#!/bin/sh\necho 'could not load its native SQLite dependency' >&2\nexit 1\n");
  await chmod(binary, 0o755);
  control = mcodeControl({ harness: harnessId("ncode-fake"), binary, lineage: "fork" });
  await expect(control.start({ prompt: promptFromText(""), cwd: dir })).rejects.toThrow(
    new RegExp(`${binary} exited with code 1: could not load its native SQLite dependency`),
  );
});

test("an effort the agent does not advertise fails the start, and an effort the kind has not got is refused before a process is started", async () => {
  control = await fakeControl({ files: ["refuse-effort"] });
  await expect(control.start({ prompt: promptFromText(""), cwd: dir, effort: "low" })).rejects.toThrow(
    /Thinking effort is not advertised for the selected model: low/,
  );

  const failure = await control.start({ prompt: promptFromText(""), cwd: dir, effort: "extreme" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Unsupported);
  expect(String(failure)).toContain('effort "extreme" is not one of default, low, medium, high, xhigh, max');
  expect((await readFile(join(dir, "argv.log"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test.skipIf(!(live && Bun.which("mcode")))(
  "the real agent accepts an effort on a MiniMax Flash session and ends a tiny turn",
  async () => {
    dir = await tempDir("mcode-effort");
    control = mcodeControl({ mode: "full", harness: harnessId("mcode-proof"), turnTimeoutMs: 120_000 });
    const { session: id } = await control.start({
      prompt: promptFromText("reply with ok"),
      cwd: dir,
      model: "minimax/MiniMax-M3.1-Flash",
      effort: "low",
    });
    expect(turnOf(await firstTurnEnded(control.life(id)), "turn-ended")).toBe(1);
  },
  180_000,
);

test.skipIf(!(live && Bun.which("mcode")))(
  "the real upstream agent takes the mode auto and ends a tiny turn on MiniMax Flash",
  async () => {
    dir = await tempDir("mcode-auto");
    const binary = process.env["MCODE_BIN"];
    control = mcodeControl({
      harness: harnessId("mcode-proof"),
      turnTimeoutMs: 120_000,
      stopGraceMs: 500,
      ...(binary === undefined ? {} : { binary }),
    });
    const { session: id, mode } = await control.start({
      prompt: promptFromText("reply with ok"),
      cwd: dir,
      model: "minimax/MiniMax-M3.1-Flash",
      mode: "auto",
    });
    expect(mode).toBe("auto");
    expect(turnOf(await firstTurnEnded(control.life(id)), "turn-ended")).toBe(1);
  },
  180_000,
);

// -- what a resume, an exit and a request leave behind -------------------------------------------------

test("a session that lost its process is resumed in the directory it is resumed with", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await control.resume(id, { cwd: workspace });
  // The fake keeps its files in its own working directory: the one it was started in.
  const loads = (await readFile(join(workspace, "sessions.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(loads[0]?.["cwd"]).toBe(workspace);
  expect(loads[0]?.["sessionId"]).toBe(id.native);
  expect(await control.state(id)).toBe("idle");
});

test("an agent that dies on its own takes the MCP servers it was given with it", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({
    prompt: promptFromText(""),
    cwd: dir,
    servers: [{ name: "niwa", command: "bun", args: ["bin/niwa.ts", "mcp"], env: {} }],
  });
  const servers = (await sessionRequestsOf())[0]?.["mcpServers"] as Array<{ env: Array<{ name: string; value: string }> }>;
  const mark = servers[0]?.env.find((entry) => entry.name === "NIWA_MCP_OWNER")?.value ?? "";
  const server = Bun.spawn(["sleep", "300"], {
    env: { ...process.env, NIWA_MCP_OWNER: mark },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await control.send(id, "die");
    await Promise.race([server.exited, Bun.sleep(5_000)]);
    expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
  } finally {
    server.kill();
  }
});

test("a model that is not advertised is never replaced by another provider's or another variant", () => {
  const advertised = [
    { value: "m:providerA:model:v:fast" },
    { value: "m:providerA:model:v:deep" },
    { value: "m:providerB:model:v:fast" },
  ];
  // The variant that was named is the variant that is asked for, or none is.
  expect(mcodeModelOptionValue("providerB/model#deep", advertised)).toBe("m:providerB:model:v:deep");
  expect(mcodeModelOptionValue("providerA/model#slow", advertised)).toBe("m:providerA:model:v:slow");
  // A provider that was named is the provider that is asked for.
  expect(mcodeModelOptionValue("providerC/model", [{ value: "m:providerA:model:v:fast" }])).toBe("m:providerC:model:u");
  // Without a variant, a named one of the same provider and model is taken.
  expect(mcodeModelOptionValue("providerB/model", advertised)).toBe("m:providerB:model:v:fast");
  // Without a provider, the model alone says which.
  expect(mcodeModelOptionValue("model", advertised)).toBe("m:providerA:model:v:fast");
});

test("a question for the person that arrives as a permission request is never answered by a policy", async () => {
  for (const permissions of ["allow", "deny"] as const) {
    const answers = await permissionAnswers(permissions, "upstream", ["questionnaire"]);
    expect(answers.at(-1)).toEqual({ outcome: { outcome: "cancelled" } });
    await control?.dispose();
    control = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a question for the person is not handed to a policy function as a tool", async () => {
  const asked: string[] = [];
  dir = await tempDir("mcode-fake");
  for (const file of ["ask-permission", "questionnaire"]) await writeFile(join(dir, file), "");
  const binary = join(dir, "mcode");
  await writeFile(binary, FAKE_AGENT);
  await chmod(binary, 0o755);
  control = mcodeControl({
    mode: "full",
    harness: harnessId("mcode-fake"),
    binary,
    permissions: async (request) => {
      asked.push(request.tool);
      return { behavior: "allow" };
    },
  });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const seen = firstTurnEnded(control.life(id));
  await control.send(id, "go");
  await seen;
  for (let i = 0; i < 100 && !existsSync(join(dir, "permission.log")); i += 1) await Bun.sleep(20);
  expect(asked).toEqual([]);
  expect((await readFile(join(dir, "permission.log"), "utf8")).trim()).toBe(JSON.stringify({ outcome: { outcome: "cancelled" } }));
});

for (const [label, bound, expected] of [
  ["its home", (home: string) => mcodeKind.bind({ id: "mcode-fake", home }), (home: string) => home],
  ["the home of its profile", () => ncodeKind.bind({ id: "mcode-fake", profile: "work" }), () => homeOfProfile("work")],
  ["the default home", () => mcodeKind.bind({ id: "mcode-fake" }), () => homeOfProfile(undefined)],
] as const) {
  test(`the profile of an installation writes the directory it keeps its sessions in: ${label}`, () => {
    const home = "/srv/install-home";
    const profile = resolveProfile(bound(home).profile ?? {}, "mcode-fake", { home: homedir(), env: {} });
    expect(profile.write).toEqual([expected(home)]);
  });
}

test("a start that is still launching its process when the control side is disposed does not complete", async () => {
  control = await fakeControl();
  const before = directChildren();
  const started = control.start({ prompt: promptFromText(""), cwd: dir });
  const outcome = started.then(
    () => "started",
    (error: unknown) => error,
  );
  await control.dispose();
  const result = await outcome;
  expect(result).not.toBe("started");
  expect(result).toMatchObject({ code: "Unavailable" });
  // Nothing it launched is left running.
  const deadline = Date.now() + 5_000;
  const leftover = () => directChildren().filter((child) => !before.some((old) => old.pid === child.pid));
  while (leftover().length > 0 && Date.now() < deadline) await Bun.sleep(50);
  expect(leftover()).toEqual([]);
});

test("two resumes of a session that lost its process share one new process", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  const here = process.cwd();
  process.chdir(dir);
  try {
    // The second one carries a prompt: it runs on the process the first one brought up.
    await Promise.all([control.resume(id), control.resume(id, { prompt: promptFromText("reply with ok") })]);
  } finally {
    process.chdir(here);
  }
  expect(await argvOf()).toHaveLength(2);
  expect(await sessionRequestsOf()).toHaveLength(2);
  // The session is held by the one process that is left, and stopping it leaves nothing running.
  expect(await control.state(id)).not.toBe("unknown");
  await control.stop(id);
  expect(await control.state(id)).toBe("unknown");
});

test("a session whose turn the agent holds past its cancel takes no new work until the turn is over", async () => {
  control = await fakeControl({ files: ["status", "deaf"], turnTimeoutMs: 300, cancelGraceMs: 600 });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "die");
  for (let i = 0; i < 100 && (await control.state(id)) !== "unknown"; i += 1) await Bun.sleep(50);
  await writeFile(join(dir, "foreign-turn"), "");
  const here = process.cwd();
  process.chdir(dir);
  try {
    await control.resume(id);
  } finally {
    process.chdir(here);
  }
  const schema = z.object({ word: z.string() });
  // The question that waited behind the held turn is told which turn holds the session.
  await expect(control.ask(id, { schema, prompt: promptFromText("give the word") })).rejects.toThrow(/holds turn "t0"/);

  // Work that comes after is refused at once, not queued behind a turn that may never end.
  const late = Promise.race([
    control.ask(id, { schema, prompt: promptFromText("give the word") }).then(() => "answered", (error: unknown) => error),
    Bun.sleep(3_000).then(() => "waiting"),
  ]);
  expect(await late).toMatchObject({ code: "Unavailable" });
  await expect(control.send(id, "more")).rejects.toMatchObject({ code: "InputNotSent" });
  await expect(control.resume(id, { prompt: promptFromText("more") })).rejects.toMatchObject({ code: "Unavailable" });
  expect(await control.state(id)).toBe("running");

  // The agent lets the turn go: the session takes work again.
  await rm(join(dir, "foreign-turn"));
  for (let i = 0; i < 100 && (await control.state(id)) !== "idle"; i += 1) await Bun.sleep(50);
  expect(await control.state(id)).toBe("idle");
  expect((await control.send(id, "again")).status).toBe("started");
});

test("a binary of the other lineage is refused in the handshake, before a session is opened", async () => {
  // The published build asked as the fork: it does not serve the fork's requests.
  control = await fakeControl({ lineage: "upstream", steer: true });
  const forkSide = mcodeControl({ mode: "full", harness: harnessId("mcode-fake"), binary: join(dir, "mcode"), lineage: "fork" });
  await expect(forkSide.start({ prompt: promptFromText(""), cwd: dir })).rejects.toMatchObject({ code: "Unavailable" });
  await expect(forkSide.start({ prompt: promptFromText(""), cwd: dir })).rejects.toThrow(/published build/);
  await forkSide.dispose();
  expect(existsSync(join(dir, "sessions.log"))).toBe(false);

  // The fork asked as the published build.
  await writeFile(join(dir, "fork"), "");
  const upstreamSide = mcodeControl({ mode: "full", harness: harnessId("mcode-fake"), binary: join(dir, "mcode"), lineage: "upstream" });
  await expect(upstreamSide.start({ prompt: promptFromText(""), cwd: dir })).rejects.toThrow(/the fork/);
  await expect(upstreamSide.resume(sessionId(harnessId("mcode-fake"), "mvs_x"), { cwd: dir })).rejects.toMatchObject({ code: "Unavailable" });
  await upstreamSide.dispose();
  expect(existsSync(join(dir, "sessions.log"))).toBe(false);
});

test("a message to an agent that has exited but whose output has not closed yet is not sent", async () => {
  control = await fakeControl();
  const before = directChildren();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const agent = directChildren().find((child) => !before.some((old) => old.pid === child.pid));
  expect(agent).toBeDefined();
  expect((await control.send(id, "orphan")).status).toBe("started");
  // The process is gone; the grandchild keeps the pipe of its output open, so the session has not
  // been told it ended.
  for (let i = 0; i < 100 && directChildren().some((child) => child.pid === agent?.pid); i += 1) await Bun.sleep(50);
  expect(directChildren().some((child) => child.pid === agent?.pid)).toBe(false);
  expect(await control.state(id)).not.toBe("unknown");
  await expect(control.send(id, "again")).rejects.toMatchObject({ code: "InputNotSent" });
  await control.dispose();
  control = undefined;
});

test("a large message to an agent that does not read its input is not waited for without end", async () => {
  control = await fakeControl({ callTimeoutMs: 500 });
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  await control.send(id, "stall");
  for (let i = 0; i < 100 && (await control.state(id)) !== "idle"; i += 1) await Bun.sleep(20);
  const asked = Date.now();
  // Part of it may be read once the agent reads again, so it is not reported as unsent.
  await expect(control.send(id, "x".repeat(4_000_000))).rejects.toMatchObject({ code: "InputPossiblySent" });
  expect(Date.now() - asked).toBeLessThan(3_000);
});

test("a turn the agent answered says it completed, and one an interrupt cut says it failed", async () => {
  control = await fakeControl();
  const { session: id } = await control.start({ prompt: promptFromText(""), cwd: dir });
  const ends: Array<[number, string | undefined]> = [];
  const watching = (async () => {
    for await (const event of control.life(id)) {
      if (event.kind === "turn-ended") {
        ends.push([event.turn, event.outcome]);
        if (ends.length === 2) return;
      }
    }
  })();
  await control.send(id, "one");
  await eventually(() => ends.length === 1, 10_000);
  await control.send(id, "hang");
  await eventually(async () => (await control.state(id)) === "running", 10_000);
  await control.interrupt(id);
  await watching;
  expect(ends).toEqual([
    [1, "completed"],
    [2, "failed"],
  ]);
});

test("a turn cut off for its time says it failed", async () => {
  control = await fakeControl({ files: ["status", "deaf"], turnTimeoutMs: 600, cancelGraceMs: 500 });
  const { session: id } = await control.start({ prompt: promptFromText("hang"), cwd: dir });
  const outcomes: Array<string | undefined> = [];
  void (async () => {
    for await (const event of control.life(id)) if (event.kind === "turn-ended") outcomes.push(event.outcome);
  })();
  await Bun.sleep(1_500);
  await writeFile(join(dir, "release"), "");
  await eventually(() => outcomes.length === 1, 10_000);
  expect(outcomes).toEqual(["failed"]);
});

test("a start tells the caller the session before its first prompt goes out", async () => {
  control = await fakeControl();
  const named: string[] = [];
  let prompted: number | undefined;
  const { session } = await control.start({
    prompt: promptFromText("one"),
    cwd: dir,
    named: async (id) => {
      named.push(id.native);
      prompted = (await readFile(join(dir, "prompts.log"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length;
    },
  });
  expect(named).toEqual([session.native]);
  expect(prompted).toBe(0);
});

test("a start whose session could not be written down gives it no work and stops the process", async () => {
  control = await fakeControl();
  const before = directChildren().map((child) => child.pid);
  await expect(
    control.start({
      prompt: promptFromText("one"),
      cwd: dir,
      named: async () => {
        throw new Error("the journal is full");
      },
    }),
  ).rejects.toThrow("the journal is full");
  expect(await readFile(join(dir, "prompts.log"), "utf8").catch(() => "")).toBe("");
  await eventually(() => directChildren().every((child) => before.includes(child.pid)), 10_000);
});

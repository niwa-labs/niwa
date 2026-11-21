// Live: a pi session that sees niwa's actions.
//
// A real pi is driven in its RPC mode over the pi kind, on a real host whose sessions module gives
// the session niwa's own MCP server. What the checks hold to is what the host saw, never what the
// model said it did:
//
//   1. a session started with niwa's tools alone calls an action of the host (the host counts the
//      call and who made it), and the transcript holds no tool of pi's own;
//   2. an agent call of a script's kind answers through niwa's `submit-answer` action, since pi
//      cannot be asked for a structured value, and the value passed the schema of the call;
//   3. a session held to an allow-list of pi's own tools calls the tool named, and none of the others,
//      beside niwa's;
//   4. the insert installed in pi's directory reports to the host that the session ended.
//
// The test is skipped unless NIWA_LIVE=1 and a pi and the bifrost extension are there. PI_BIN names the pi to run (default: `pi` on the PATH) and
// PI_MODEL the model, in pi's words (default: bifrost/zai/glm-5.3-flash).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { action, actionName } from "@niwa-labs/core";
import type { ActionName } from "@niwa-labs/core";
import { harnessId, sessionId } from "@niwa-labs/harness";
import type { SessionRecord } from "@niwa-labs/harness";
import { pi } from "@niwa-labs/harness-pi";
import type { PiSessionControl } from "@niwa-labs/harness-pi";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { messages } from "@niwa-labs/messages";
import { plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { insertPlugin, sessions } from "@niwa-labs/sessions";
import { connectAsOwner, eventually, live, runFinishes, tempDir, tempHome } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";
import { z } from "zod";

import { NIWA_CLI, installInsert } from "../src/inserts.ts";

const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_MODEL = process.env.PI_MODEL ?? "bifrost/zai/glm-5.3-flash";
const HARNESS = harnessId("pi-live");
const TURN_DEADLINE_MS = 240_000;
const NONCE = `code-${randomUUID().slice(0, 8)}`;

/** Who called the probe, as the host bound them. */
const probed: Array<{ kind: string }> = [];

/** The action the session is to call: it answers a code that only the host knows. */
const probe = action("probe.code", {
  description: "Returns the secret code of this host. The code cannot be guessed: call this action to learn it.",
  input: z.object({}),
  output: z.object({ code: z.string() }),
  recovery: "repeat",
  effect: "read",
  run: async (_input, ctx) => {
    probed.push({ kind: ctx.caller.kind });
    return { code: NONCE };
  },
});

let host: Host;
let control: PiSessionControl;
let hostHome: string;
let piHome: string;
let reading: ReturnType<typeof pi>["reading"];

/**
 * A home of pi's own for the test: its settings and its bifrost extension, without the packages (the
 * packages of the owner may not load with this pi) and without the other extensions.
 */
async function makePiHome(): Promise<string> {
  const home = await tempDir("live-pi-home");
  const real = join(homedir(), ".pi", "agent");
  const settings = JSON.parse(await readFile(join(real, "settings.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
  delete settings.packages;
  await Bun.write(join(home, "settings.json"), JSON.stringify(settings, null, 2));
  await mkdir(join(home, "extensions"), { recursive: true });
  await cp(join(real, "extensions", "bifrost"), join(home, "extensions", "bifrost"), { recursive: true });
  return home;
}

beforeAll(async () => {
  if (!runs) return;
  hostHome = (await tempHome()).path;
  piHome = await makePiHome();
  const binding = pi({
    id: String(HARNESS),
    home: piHome,
    model: PI_MODEL,
    control: { mode: "full", binary: PI_BIN, turnTimeoutMs: TURN_DEADLINE_MS },
  });
  if (binding.control === undefined || binding.reading === undefined) throw new Error("the pi installation has no control or reading side");
  control = binding.control as PiSessionControl;
  reading = binding.reading;
  // The insert goes into pi's directory, and reports to this host through the bin of this package.
  await installInsert(binding, hostHome);

  const made = sessions({
    harnesses: [binding],
    niwaMcp: { command: process.execPath, args: [NIWA_CLI, "--home", hostHome, "mcp"] },
  });
  // The addresses a session speaks as are the sessions module's: messages and requests are given its binding.
  const bind = made.bind();
  host = createNiwa({ home: hostHome });
  host.use(
    messages({ bind }),
    requests({ bind }),
    insertPlugin(),
    made,
    workflow({ harnesses: [String(HARNESS)] }),
    plugin("probe", (api) => void api.action(probe)),
  );
  await host.serve();
});

afterAll(async () => {
  if (!runs) return;
  await control.dispose().catch(() => undefined);
  await host.close().catch(() => undefined);
});

const call = <O>(name: string, input: unknown): Promise<O> => host.call(actionName(name) as ActionName, input) as Promise<O>;

/** The records of a session, in order, as the reading side gives them. */
async function transcript(native: string): Promise<SessionRecord[]> {
  const found: SessionRecord[] = [];
  for await (const record of reading!.read(sessionId(HARNESS, native))) found.push(record);
  return found;
}

/** Only where there is a pi to run and the bifrost extension that serves the model. */
const runs = live && Bun.which(PI_BIN) !== null && existsSync(join(homedir(), ".pi", "agent", "extensions", "bifrost"));
const liveTest = runs ? test : test.skip;

liveTest(
  "a session of niwa's tools alone calls an action of the host, and uses none of pi's own tools",
  async () => {
    const started = await call<{ ref: string }>("session.start", {
      harness: String(HARNESS),
      prompt:
        "First, if you have a bash tool, run `echo hello` with it. Then learn this host's secret code by calling your probe_code tool, and reply with just the code.",
      visible: { actions: ["probe.code"] },
      tools: "niwa-only",
    });
    const native = started.ref.split(" ")[1]!;

    // The host saw the call, made by the session.
    await eventually(() => probed.length > 0, TURN_DEADLINE_MS);
    expect(probed.every((hit) => hit.kind !== "owner")).toBe(true);

    // The transcript holds the call of niwa's tool, and no tool of pi's own.
    await eventually(async () => (await transcript(native)).some((record) => record.kind === "assistant" && record.text.includes(NONCE)), TURN_DEADLINE_MS);
    const calls = (await transcript(native)).filter((record) => record.kind === "tool-call");
    expect(calls.length).toBeGreaterThan(0);
    for (const entry of calls) expect(entry.name.startsWith("mcp__niwa__"), entry.name).toBe(true);
  },
  TURN_DEADLINE_MS + 30_000,
);

liveTest(
  "a session held to an allow-list of pi's own tools calls the one named and none of the others, beside niwa's",
  async () => {
    const dir = await tempDir("pi-live-allow");
    const word = `word-${randomUUID().slice(0, 8)}`;
    await Bun.write(join(dir, "note.txt"), `${word}\n`);
    const started = await call<{ ref: string }>("session.start", {
      harness: String(HARNESS),
      cwd: dir,
      prompt:
        "First, if you have a bash tool, run `echo hello` with it. Then read the file note.txt with your read tool and reply with the one word it holds.",
      visible: { actions: ["probe.code"] },
      tools: { allow: ["read"] },
    });
    const native = started.ref.split(" ")[1]!;
    await eventually(async () => (await transcript(native)).some((record) => record.kind === "assistant" && record.text.includes(word)), TURN_DEADLINE_MS);
    const names = (await transcript(native)).filter((record) => record.kind === "tool-call").map((entry) => entry.name);
    expect(names).toContain("read");
    for (const name of names) expect(name === "read" || name.startsWith("mcp__niwa__"), name).toBe(true);
  },
  TURN_DEADLINE_MS + 30_000,
);

liveTest(
  "a workflow session answers through niwa's submit-answer action, with a value that passed its schema",
  async () => {
    const before = probed.length;
    const dir = await tempDir("pi-live-script");
    const file = join(dir, "ask.workflow.js");
    await Bun.write(
      file,
      `export default workflow({ uses: ["session.start.${String(HARNESS)}", "probe.code"], output: z.json() }, async () =>
  ask({
    harness: ${JSON.stringify(String(HARNESS))},
    visible: ["probe.code"],
    schema: z.object({ code: z.string() }),
  }, "Learn this host's secret code by calling your probe_code tool, then answer with it."),
);
`,
    );
    const api = await connectAsOwner(hostHome);
    try {
      const started = await api.call(actionName("workflow.start") as ActionName, { file });
      const { run } = z.object({ run: z.string() }).parse(started);
      await runFinishes(api, run, TURN_DEADLINE_MS);
      const finished = (await api.records.read()).find((record) => record.type === "workflow.run.finished");
      const outcome = z.object({ outcome: z.object({ status: z.string(), result: z.unknown() }) }).parse(finished?.data);
      expect(outcome.outcome).toEqual({ status: "done", result: { code: NONCE } });
      // The session that answered called the host: the value it gave is the one the host holds.
      expect(probed.length).toBeGreaterThan(before);
    } finally {
      await api.close();
    }
  },
  TURN_DEADLINE_MS + 30_000,
);

liveTest(
  "the insert installed in pi's directory reports the end of a session to the host",
  async () => {
    const started = await call<{ session: string }>("session.start", { harness: String(HARNESS), prompt: "" });
    await call("session.end", { session: started.session, reason: "the check is done" });
    await eventually(async () => (await host.records.read()).some((record) => record.type === "insert.session-ended"), 60_000);
  },
  90_000,
);

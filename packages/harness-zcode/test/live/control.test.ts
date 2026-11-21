// The ZCode control side and reading side, live.
//
// A real `zcode app-server` is started in a temporary directory and given a few tiny turns: a
// start with a prompt, a question answered by schema, and in a fresh process a resume, a send
// and an interrupt that cuts the turn. The session is then read back from ZCode's own database.
//
// The test is skipped unless NIWA_LIVE=1 and `zcode` is on the PATH. The model is the one the
// installation runs by default; `NIWA_ZCODE_MODEL` (`providerId/modelId`) and `NIWA_ZCODE_EFFORT`
// name another. Z.AI account models are injected by the desktop app and are not reachable from a
// standalone `zcode app-server`, so the default model is the one that works here.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import type { LifeEvent, SessionControl, SessionId, SessionRecord } from "@niwa-labs/harness";
import { live, tempDir } from "@niwa-labs/testing";

import { ZcodeReading } from "../../src/reading.ts";
import { zcodeControl } from "../../src/control.ts";
import type { ZcodeSessionControl } from "../../src/control.ts";

const installed = Bun.which("zcode") !== null;
const MODEL = process.env["NIWA_ZCODE_MODEL"];
const EFFORT = process.env["NIWA_ZCODE_EFFORT"];
const HARNESS = harnessId("zcode-live");
const HOME = join(homedir(), ".zcode");

/** How long one turn may take before the test gives up on it. */
const TURN_DEADLINE_MS = 240_000;

function control(): ZcodeSessionControl {
  return zcodeControl({
    harness: HARNESS,
    home: HOME,
    ...(MODEL === undefined ? {} : { model: MODEL }),
    ...(EFFORT === undefined ? {} : { effort: EFFORT }),
  });
}

/** Watches the signs of life until a turn ends; the stream is forward-only, so this is called before the action. */
function turnEnded(side: SessionControl, id: SessionId): Promise<LifeEvent[]> {
  const stream = side.life(id)[Symbol.asyncIterator]();
  const seen: LifeEvent[] = [];
  const watching = (async () => {
    for (;;) {
      const next = await stream.next();
      if (next.done === true) throw new Error("the session ended before the turn did");
      seen.push(next.value);
      if (next.value.kind === "turn-ended") return seen;
    }
  })();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`the turn did not end within ${TURN_DEADLINE_MS} ms`)), TURN_DEADLINE_MS);
    void watching.finally(() => clearTimeout(timer)).catch(() => undefined);
  });
  return Promise.race([watching, deadline]).finally(() => void stream.return?.());
}

async function records(id: SessionId): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for await (const record of new ZcodeReading({ harness: HARNESS, home: HOME }).read(id)) out.push(record);
  return out;
}

test.skipIf(!live || !installed)(
  "a real ZCode starts, answers by schema, resumes in a new process, and is interrupted",
  async () => {
    const cwd = await tempDir("live-zcode");
    const first = control();
    let session: SessionId | undefined;
    try {
      const started = await first.start({ prompt: promptFromText("Reply with the single word ok."), cwd });
      session = started.session;
      expect(String(session.native)).toMatch(/^sess_/);
      expect(started.first?.status).toBe("started");
      const signs = await turnEnded(first, session);
      expect(signs.some((event) => event.kind === "turn-started")).toBe(true);

      const answer = await first.ask(session, {
        schema: z.object({ word: z.string() }),
        prompt: promptFromText('Reply with the JSON {"word": "ok"}'),
      });
      expect(answer.value.word.toLowerCase()).toContain("ok");

      // The session is in ZCode's database once a turn has completed, and the reading side finds the conversation there.
      const read = await records(session);
      expect(read.some((record) => record.kind === "user" && record.text.includes("single word ok"))).toBe(true);
      expect(read.some((record) => record.kind === "assistant")).toBe(true);
      expect(read.every((record) => !record.incomplete)).toBe(true);
    } finally {
      await first.dispose();
    }
    if (session === undefined) throw new Error("the session was never named");

    // A fresh process takes the session up by its id; a message begins a turn, and the interrupt cuts it.
    const second = control();
    try {
      await second.resume(session);
      const ended = turnEnded(second, session);
      const receipt = await second.send(session, "Write the numbers from 1 to 400, one per line, with no other text.");
      expect(receipt.status).toBe("started");
      await second.interrupt(session);
      const signs = await ended;
      expect(signs.some((event) => event.kind === "turn-ended")).toBe(true);
      expect(await second.state(session)).toBe("idle");
    } finally {
      await second.dispose();
    }
  },
  TURN_DEADLINE_MS * 3,
);

/**
 * A stdio MCP server of one tool, `niwa_probe`: it writes `probe.called` next to itself when the
 * tool is called, so the test knows the call came from the session, whatever the model then says.
 */
const PROBE_SERVER = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{ name: "niwa_probe", description: "Call this tool to prove the server is connected. Takes no arguments.", inputSchema: { type: "object", properties: {} } }] });
    } else if (message.method === "tools/call") {
      writeFileSync(join(import.meta.dir, "probe.called"), "yes");
      reply(message.id, { content: [{ type: "text", text: "probe-ok" }] });
    } else {
      reply(message.id, {});
    }
  }
});
`;

test.skipIf(!live || !installed)(
  "a real ZCode is given an MCP server at its start, and calls the tool of it",
  async () => {
    const cwd = await tempDir("live-zcode-mcp");
    const script = join(cwd, "probe-server.ts");
    await writeFile(script, PROBE_SERVER);
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText("Call the tool niwa_probe of the MCP server named probe once, then reply with the single word done."),
        cwd,
        mode: "full",
        servers: [{ name: "probe", command: process.execPath, args: [script], env: {} }],
      });
      await turnEnded(side, started.session);
      expect(existsSync(join(cwd, "probe.called"))).toBe(true);
    } finally {
      await side.dispose();
    }
  },
  TURN_DEADLINE_MS * 2,
);

test.skipIf(!live || !installed)(
  "a real ZCode takes a deny-list at its start and does not offer the tool in it",
  async () => {
    const cwd = await tempDir("live-zcode-deny");
    const script = join(cwd, "probe-server.ts");
    await writeFile(script, PROBE_SERVER);
    const side = control();
    try {
      const started = await side.start({
        prompt: promptFromText("Call the tool niwa_probe of the MCP server named probe once if you have it, then reply with the single word done."),
        cwd,
        mode: "full",
        servers: [{ name: "probe", command: process.execPath, args: [script], env: {} }],
        visible: { actions: [], disabledTools: ["mcp__probe__niwa_probe"] },
      });
      await turnEnded(side, started.session);
      expect(existsSync(join(cwd, "probe.called"))).toBe(false);
    } finally {
      await side.dispose();
    }
  },
  TURN_DEADLINE_MS * 2,
);

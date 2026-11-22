import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { sessionId } from "@niwa-labs/harness";
import { ncode } from "@niwa-labs/harness-mcode";
import { readTranscript } from "@niwa-labs/history";
import { tempHome } from "@niwa-labs/testing";

test("the session.read transcript path gives Ncode full pages, digest, and brief after an offload", async () => {
  const home = await tempHome();
  try {
    const native = "mvs_history_test";
    const data = join(home.path, "ncode");
    const directory = join(data, "durable-history", "sessions", native);
    mkdirSync(directory, { recursive: true });

    const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
    const envelope = (message_id: string, message: object) => ({ message_id, turn_id: "turn", message });
    const entry = (name: string, kind: string, body: object) => ({
      id: `${native}|${name}`, parentId: null, kind, payload: { sessionId: native, ...body },
    });
    const entries = [
      entry("full", "history.v1.full", { reason: "seed", envelopes: [envelope("first", user("older question"))] }),
      entry("append", "history.v1.append", { envelopes: [
        envelope("request", user("inspect fixture")),
        envelope("call", { role: "assistant", timestamp: 2, content: [
          { type: "toolCall", id: "call", name: "bash", arguments: { command: "printf fixture" } },
        ] }),
        envelope("output", { role: "toolResult", toolCallId: "call", toolName: "bash", content: "original", timestamp: 3 }),
      ] }),
      entry("offload", "history.v2.offload", {
        kind: "history.v2.offload", seq: 2, blockIdx: 2, artifactRef: "fixture-artifact", replacement: "stored output",
      }),
      entry("reply", "history.v1.append", { envelopes: [
        envelope("reply", { role: "assistant", content: [{ type: "text", text: "fixture reply" }], timestamp: 4 }),
      ] }),
    ];
    const json = Buffer.from(JSON.stringify(entries));
    const frame = gzipSync(json);
    const header = Buffer.alloc(21);
    header.write("MZS2");
    header[4] = 2;
    header.writeBigUInt64BE(BigInt(json.length), 5);
    header.writeBigUInt64BE(BigInt(frame.length), 13);
    const db = new Database(join(directory, "sessions.g1.db"));
    try {
      db.run("create table batches (batch_id integer primary key, payload blob not null)");
      db.run("create table entries (entry_id text primary key, seq integer not null, ordinal integer not null, batch_id integer not null)");
      db.run("insert into batches values (1, ?)", [Buffer.concat([header, frame])]);
      for (const [ordinal, { id }] of entries.entries()) {
        db.run("insert into entries values (?, 1, ?, 1)", [id, ordinal]);
      }
    } finally {
      db.close();
    }
    const binding = ncode({ home: data });
    const session = sessionId(binding.instance.id, native);
    const read = (input: Parameters<typeof readTranscript>[2]) => readTranscript(binding, session, input);

    const full = await read({ mode: "full" });
    expect(full.coverage.status).toBe("not-scanned");
    expect(full.records.map((record) => record.kind)).toEqual(["user", "user", "tool-call", "tool-result", "assistant"]);
    expect(full.records[3]).toMatchObject({ output: "stored output" });

    const page = await read({ mode: "full", window: { limit: 3 } });
    expect(page.page).toEqual({ hasEarlier: true });
    expect(page.records).toEqual(full.records.slice(2));
    const earlier = await read({ mode: "full", window: { limit: 3, before: page.records[0]!.locator } });
    expect(earlier.page).toEqual({ hasEarlier: false });
    expect(earlier.records).toEqual(full.records.slice(0, 2));
    expect((await read({ from: earlier.records[1]!.locator })).records).toEqual(page.records);

    const digest = await read({ mode: "digest" });
    expect(digest.coverage.status).toBe("not-scanned");
    expect(digest.digest?.view).toMatchObject({
      mode: "digest",
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "fixture reply" }),
      ]),
    });
    const brief = await read({ mode: "brief" });
    expect(brief.coverage.status).toBe("not-scanned");
    expect(brief.digest?.view).toMatchObject({
      mode: "brief", brief: { answered: [{ text: "fixture reply" }] },
    });
  } finally {
    await home.cleanup();
  }
});

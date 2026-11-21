import { expect, test } from "bun:test";

import { sourceOf } from "@niwa-labs/digest";
import { LocatorSchema, harnessId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionReading, SessionRecord } from "@niwa-labs/harness";

import { readTranscript } from "../src/index.ts";

const H = harnessId("h");
const ID = sessionId(H, "s1");
const at = (n: number) => LocatorSchema.parse(`L${String(n)}`);

const instance: Harness = {
  id: H,
  kind: "k" as never,
  machine: "m" as never,
  home: "/tmp/h",
  sides: { reading: { list: true, read: true, watch: false } },
};

const records: SessionRecord[] = [
  {
    kind: "user",
    text: "see <system-reminder>r</system-reminder> this",
    inserted: [{ from: 4, to: 39, origin: "harness" }],
    images: [{ at: 4, mime: "image/png" }],
    reanchored: true,
    locator: at(1),
    incomplete: false,
  },
  { kind: "tool-call", callId: "c1", name: "apply_patch", category: "edit", target: "a.ts", paths: ["a.ts", "b.ts"], locator: at(2), incomplete: false },
  { kind: "tool-result", callId: "c1", output: [{ type: "text", text: "ok" }], images: [{ at: 1 }], locator: at(3), incomplete: false },
];

const reading: SessionReading = {
  async *list() {
    yield { id: ID };
  },
  async *read(_id, from) {
    const start = from === undefined ? 0 : records.findIndex((record) => record.locator === from) + 1;
    yield* records.slice(start);
  },
  raw: async () => undefined,
  rawSchema: { parse: (value: unknown) => value } as never,
  coverage: async () => ({ status: "not-scanned" }),
};

test("a read gives every field of a record, so its digest source is the record's own", async () => {
  const answer = await readTranscript({ instance, reading }, ID, {});
  expect(answer.records).toEqual(records);
  expect(answer.records.map((record) => sourceOf(record as SessionRecord).digest)).toEqual(records.map((record) => sourceOf(record).digest));
});

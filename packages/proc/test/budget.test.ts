// What the options of the module may be, and what a record may hold.
//
// What it proves:
//   1. an option that is not a usable number is refused when the module is made, not on a call
//   2. the tail of a result is cut to what a `proc.finished` record can hold, so a command that has
//      run and stored its output still gives its result, however its tail is escaped in the journal
//   3. a working directory or a program too long for the record is refused before anything starts

import { afterEach, expect, test } from "bun:test";

import { RECORD_DATA_LIMIT } from "@niwa-labs/core";

import { MAX_TAIL_BYTES, procRun } from "../src/index.ts";
import { proc } from "../src/index.ts";
import { dirIn, outputOf, procHost, recordingSandbox } from "./support.ts";

type Host = Awaited<ReturnType<typeof procHost>>;
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

test("an option that is not a usable number is refused when the module is made", () => {
  expect(() => proc({ tailBytes: MAX_TAIL_BYTES + 1 })).toThrow(/tailBytes/);
  expect(() => proc({ tailBytes: -1 })).toThrow(/tailBytes/);
  expect(() => proc({ tailBytes: 1.5 })).toThrow(/tailBytes/);
  expect(() => proc({ outputLimit: 0 })).toThrow(/outputLimit/);
  expect(() => proc({ outputLimit: Number.NaN })).toThrow(/outputLimit/);
  expect(() => proc({ killGraceMs: -5 })).toThrow(/killGraceMs/);
  expect(() => proc({ tailBytes: MAX_TAIL_BYTES, outputLimit: 1, killGraceMs: 0 })).not.toThrow();
});

test("a tail that escapes to more than a record can hold is cut, and the command's result is still returned", async () => {
  const host = await procHost({ sandbox: recordingSandbox(), tailBytes: MAX_TAIL_BYTES });
  hosts.push(host);
  const cwd = dirIn(host.home, "work");
  // Every byte of a control character is six bytes of JSON.
  const result = await host.niwa.call(procRun, { cmd: ["/bin/sh", "-c", `head -c ${MAX_TAIL_BYTES} /dev/zero | tr '\\0' '\\1'`], cwd, timeout: 20_000 });
  expect(result.exit).toBe(0);
  expect(outputOf(host, result.output)).toHaveLength(MAX_TAIL_BYTES);
  expect(result.tail.length).toBeGreaterThan(0);
  expect(result.tail.length).toBeLessThan(MAX_TAIL_BYTES);
  expect(Buffer.byteLength(JSON.stringify(result.tail))).toBeLessThan(RECORD_DATA_LIMIT);
  const finished = (await host.niwa.records.read()).filter((row) => row.type === "proc.finished");
  expect(finished).toHaveLength(1);
  expect((finished[0]?.data as { tail: string }).tail).toBe(result.tail);
});

test("a working directory or a program too long for the record is refused before anything starts", async () => {
  const host = await procHost({ sandbox: recordingSandbox() });
  hosts.push(host);
  const cwd = dirIn(host.home, "work");
  await expect(host.niwa.call(procRun, { cmd: ["x".repeat(5000)], cwd, timeout: 1000 })).rejects.toThrow();
  await expect(host.niwa.call(procRun, { cmd: ["/usr/bin/true"], cwd: `/${"d".repeat(5000)}`, timeout: 1000 })).rejects.toThrow();
});

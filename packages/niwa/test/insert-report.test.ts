// `niwa insert report`: the one command an insert reports through (the hook of Claude Code, the
// extension of pi). The command is a client of the host; the insert only starts it.

import { expect, test } from "bun:test";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { seq } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { INSERT_REPORT_ACTION, reportThroughCli } from "@niwa-labs/harness";
import { insertPlugin } from "@niwa-labs/sessions";
import { tempHome, connectAsOwner } from "@niwa-labs/testing";

import { INSERT_REPORT, INSERT_USAGE, runInsert } from "@niwa-labs/cli";
import { niwaCli } from "./fixtures/niwa-cli.ts";

const COMPACTED = { kind: "compacted", session: { harness: "pi", native: "s1" }, summary: "so far" };

test("the command calls the action the insert plugin serves", () => {
  expect(INSERT_REPORT).toBe(INSERT_REPORT_ACTION);
});

test("the command refuses what is not `report` with an event on stdin", async () => {
  const home = await tempHome();
  try {
    const event = async () => JSON.stringify(COMPACTED);
    expect(await runInsert([], home.path, event)).toEqual({ output: INSERT_USAGE, code: 2 });
    expect(await runInsert(["other"], home.path, event)).toEqual({ output: INSERT_USAGE, code: 2 });
    expect(await runInsert(["report", "extra"], home.path, event)).toEqual({ output: INSERT_USAGE, code: 2 });
    expect((await runInsert(["report"], home.path, async () => "not json{")).code).toBe(2);
    expect((await runInsert(["report"], home.path, async () => "[1]")).code).toBe(2);
    expect((await runInsert(["report"], home.path, async () => "null")).code).toBe(2);
    // No host at the home.
    expect((await runInsert(["report"], home.path, event)).code).toBe(1);
  } finally {
    await home.cleanup();
  }
});

test("the command writes the record of the event through the host, and a refused event is code 1", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(insertPlugin());
  await niwa.serve();
  try {
    const sent = await runInsert(["report"], home.path, async () => JSON.stringify(COMPACTED));
    expect(sent).toEqual({ output: "", code: 0 });

    const client = await connectAsOwner(home.path);
    const stream = client.records.since(seq(0), { type: "insert.compacted" as never }) as AsyncGenerator<StoredRecord>;
    const first = await stream.next();
    expect(first.value?.data).toEqual({ session: { harness: "pi", native: "s1" }, summary: "so far" });
    await stream.return(undefined);
    await client.close().catch(() => {});

    const refused = await runInsert(["report"], home.path, async () => JSON.stringify({ kind: "nope" }));
    expect(refused.code).toBe(1);
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

test("the insert helper runs `niwa insert report` with the event on stdin, and says why it failed", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(insertPlugin());
  await niwa.serve();
  try {
    const cli = await niwaCli(home.path);
    await reportThroughCli(COMPACTED, { home: home.path, cli });
    await expect(reportThroughCli({ kind: "nope" }, { home: home.path, cli })).rejects.toThrow("failed (1)");
    await expect(reportThroughCli(COMPACTED, { home: home.path, cli: join(home.path, "missing") })).rejects.toThrow(
      "could not run",
    );
    // A command that never ends is stopped at the deadline.
    const slow = join(home.path, "slow.sh");
    await Bun.write(slow, "#!/bin/sh\nsleep 30\n");
    await Bun.$`chmod +x ${slow}`;
    await expect(reportThroughCli(COMPACTED, { home: home.path, cli: slow, deadlineMs: 200 })).rejects.toThrow(
      "did not end in time",
    );
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);

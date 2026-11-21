// A script that writes to the stdout does not break the protocol.
//
// The script and the child share one stdout: a line of the protocol is told from an ordinary
// line by its prefix. A script that writes a line of its own (a `console.log`) is passed
// through as a log of the run, and the run goes on.
//
// The scenario runs against a real host process (test/fixtures/revision-host.ts).

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { StoredRecord } from "@niwa-labs/core";
import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/revision-host.ts", import.meta.url));

/** What the workflow actions answer. */
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

/** The data of the record of a log line of a run. */
const RunLog = z.object({ run: z.string(), text: z.string() });

/** The log lines of the runs, as the journal holds them. */
function logsOf(records: StoredRecord[]): string[] {
  const texts: string[] = [];
  for (const record of records) {
    if (record.type !== "workflow.run.log") continue;
    const data = RunLog.safeParse(record.data);
    if (data.success) texts.push(data.data.text);
  }
  return texts;
}

test("a script that writes to the stdout does not break the protocol", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;

  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);
    const observer = await watch(homePath);
    const seen = observer.seen;

    // The script writes a line of its own, then makes a call that finishes.
    const script = `${homePath}/stdout-script.js`;
    await Bun.write(
      script,
      [
        'export default workflow({ uses: ["revision.agent"], output: z.json() }, async () => {',
        '  console.log("the script writes a line of its own");',
        '  const answer = await ask({ label: "work:first" }, "Study the core.");',
        "  return answer;",
        '});',
        "",
      ].join("\n"),
    );

    const started = RunOutput.parse(
      await client.call("workflow.start" as never, { file: script } as never),
    );

    // The run finished: the line the script wrote did not break the protocol.
    await eventually(
      () => seen.some((record) => record.type === "workflow.run.finished"),
      30_000,
      "the run should have finished",
    );
    const finished = seen.find((record) => record.type === "workflow.run.finished");
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      answer: "answered: Study the core.",
    });

    // The line the script wrote was passed through as a log of the run.
    expect(logsOf(seen)).toContain("the script writes a line of its own");

    // The call was made once, and the run ended with the answer of it.
    expect(counter(homePath, "revision.agent").count()).toBe(1);

    await client.close().catch(() => {});
    await observer.stop();
  } finally {
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

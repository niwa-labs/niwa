// A script error pauses the run with a request, and the run waits on it.
//
// A failure pauses the run with a request. A script that throws (and no step failed) pauses its
// invocation too, so a run said to be paused always has something on the owner's list to answer.
//
// The scenario runs against a real host process (test/fixtures/revision-host.ts).

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { ActionName, StoredRecord } from "@niwa-labs/core";
import { REQUEST_OPEN } from "@niwa-labs/requests/records";
import { connect, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/revision-host.ts", import.meta.url));
const RESOLVE = "niwa.invocation.resolve" as ActionName;

const RunOutput = z.object({ run: z.string(), finished: z.boolean() });
const Listed = z.object({ requests: z.array(z.record(z.string(), z.unknown())) });
const State = z.object({ invocation: z.string(), state: z.string(), choices: z.array(z.string()).optional() });

function states(seen: StoredRecord[]): Array<z.infer<typeof State>> {
  return seen.flatMap((record) => {
    if (record.type !== "niwa.invocation.state") return [];
    const parsed = State.safeParse(record.data);
    return parsed.success ? [parsed.data] : [];
  });
}

test("a script error pauses the invocation with a request, and a retry goes on", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);
    observer = await watch(homePath);
    const seen = observer.seen;

    // The script makes a call that finishes, then throws unless the flag file exists.
    const flag = `${homePath}/fixed`;
    const script = `${homePath}/error-script.js`;
    await Bun.write(
      script,
      [
        'export default workflow({ uses: ["revision.agent"], output: z.json() }, async () => {',
        '  const first = await ask({ label: "work:first" }, "Study the core.");',
        `  if (!(await Bun.file(${JSON.stringify(flag)}).exists())) throw new Error("the script is broken");`,
        "  return first;",
        '});',
        "",
      ].join("\n"),
    );
    const started = RunOutput.parse(await client.call("workflow.start" as never, { file: script } as never));

    await eventually(() => states(seen).some((s) => s.state === "paused"), 20_000, "the invocation should pause");
    const pause = states(seen).find((s) => s.state === "paused");
    if (pause === undefined) throw new Error("no pause");
    // A failure of the script itself is on no step: there is no step to skip.
    expect(pause.choices).toEqual(["retry", "cancel"]);

    // The run waits on a request that the owner sees.
    const open = Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((entry) => entry.kind === "paused");
    expect(open).toHaveLength(1);
    expect(open[0]?.invocation).toBe(pause.invocation);
    expect(open[0]?.choices).toEqual(["retry", "cancel"]);
    // The invocation does not end as done after the pause.
    expect(states(seen).filter((s) => s.invocation === pause.invocation).at(-1)?.state).toBe("paused");
    expect(seen.filter((r) => r.type === "workflow.run.finished")).toHaveLength(0);

    // The script is fixed and the owner retries: the run finishes.
    await Bun.write(flag, "1");
    await client.call(RESOLVE, { invocation: pause.invocation, choice: "retry" });
    await eventually(
      () => seen.some((r) => r.type === "workflow.run.finished"),
      30_000,
      "the run should finish after the retry",
    );
    const finished = seen.find((r) => r.type === "workflow.run.finished");
    expect((finished?.data as { run?: string }).run).toBe(started.run);
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({ answer: "answered: Study the core." });
    await eventually(
      () => states(seen).filter((s) => s.invocation === pause.invocation).at(-1)?.state === "done",
      20_000,
      "the invocation should end as done",
    );
    expect(Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((e) => e.kind === "paused")).toHaveLength(0);
    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a resume of a run paused by a script error resolves the pause and starts one run", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);
    observer = await watch(homePath);
    const seen = observer.seen;
    const flag = `${homePath}/fixed`;
    const script = `${homePath}/error-script.js`;
    await Bun.write(
      script,
      [
        'export default workflow({ uses: ["revision.agent"], output: z.json() }, async () => {',
        `  if (!(await Bun.file(${JSON.stringify(flag)}).exists())) throw new Error("the script is broken");`,
        '  return await ask({ label: "work:first" }, "Study the core.");',
        '});',
        "",
      ].join("\n"),
    );
    const started = RunOutput.parse(await client.call("workflow.start" as never, { file: script } as never));
    await eventually(() => states(seen).some((s) => s.state === "paused"), 20_000, "the invocation should pause");
    await Bun.write(flag, "1");
    await client.call("workflow.resume" as never, { run: started.run } as never);
    await eventually(() => seen.some((r) => r.type === "workflow.run.finished"), 30_000, "the run should finish");
    expect(seen.filter((r) => r.type === "workflow.run.finished")).toHaveLength(1);
    expect(Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((e) => e.kind === "paused")).toHaveLength(0);
    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

async function brokenRun(homePath: string, client: Awaited<ReturnType<typeof connect>>) {
  const script = `${homePath}/broken.js`;
  await Bun.write(
    script,
    [
      'export default workflow({ uses: ["revision.agent"] }, async () => {',
      '  await ask({ label: "work:first" }, "Study the core.");',
      '  throw new Error("the script is broken");',
      '});',
      "",
    ].join("\n"),
  );
  return RunOutput.parse(await client.call("workflow.start" as never, { file: script } as never));
}

test("a cancel of the pause ends the invocation, and a retry that fails again does not leave a second pause request", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    const client = await connectAsOwner(homePath);
    observer = await watch(homePath);
    const seen = observer.seen;
    await brokenRun(homePath, client);
    await eventually(() => states(seen).some((s) => s.state === "paused"), 20_000, "the invocation should pause");
    const pause = states(seen).find((s) => s.state === "paused");
    if (pause === undefined) throw new Error("no pause");
    // A skip of a failure of the script itself is not offered: there is no step to skip.
    await expect(client.call(RESOLVE, { invocation: pause.invocation, choice: "skip" })).rejects.toThrow("does not offer skip");
    // A retry reruns it and it pauses again: one request, not two.
    await client.call(RESOLVE, { invocation: pause.invocation, choice: "retry" });
    await eventually(
      () => states(seen).filter((s) => s.invocation === pause.invocation && s.state === "paused").length >= 2,
      20_000,
      "the retry reruns the script, which pauses again",
    );
    const open = Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((e) => e.kind === "paused");
    expect(open).toHaveLength(1);
    // RunPaused is not written twice for the same error.
    expect(seen.filter((r) => r.type === "workflow.run.paused")).toHaveLength(1);
    await client.call(RESOLVE, { invocation: pause.invocation, choice: "cancel" });
    await eventually(
      () => states(seen).filter((s) => s.invocation === pause.invocation).at(-1)?.state === "done",
      20_000,
      "the cancel should end the invocation",
    );
    expect(Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((e) => e.kind === "paused")).toHaveLength(0);
    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("a restart while paused keeps one pause and one request, and no second call", async () => {
  const home = await tempHome();
  const homePath = home.path;
  let host: ReturnType<typeof spawnHost> | undefined;
  let observer: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    let client = await connectAsOwner(homePath);
    observer = await watch(homePath);
    const seen = observer.seen;
    await brokenRun(homePath, client);
    await eventually(() => states(seen).some((s) => s.state === "paused"), 20_000, "the invocation should pause");
    const pause = states(seen).find((s) => s.state === "paused");
    if (pause === undefined) throw new Error("no pause");
    await client.close().catch(() => {});
    await host.kill();
    host = spawnHost(HOST_SCRIPT, homePath);
    await host.ready();
    client = await connectAsOwner(homePath);
    const open = Listed.parse(await client.call(REQUEST_OPEN, {})).requests.filter((e) => e.kind === "paused");
    expect(open).toHaveLength(1);
    expect(open[0]?.invocation).toBe(pause.invocation);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(seen.filter((r) => r.type === "workflow.run.paused")).toHaveLength(1);
    expect(seen.filter((r) => r.type === "workflow.run.finished")).toHaveLength(0);
    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

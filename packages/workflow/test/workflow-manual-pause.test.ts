import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RequestCreated, requestAnswer } from "@niwa-labs/requests/records";
import { counter, eventually, gate, spawnHost, tempHome, connectAsOwner, watch } from "@niwa-labs/testing";
import { workflowContinue, workflowInspect, workflowPause, workflowStart, workflowWait } from "../src/index.ts";



test("manual pause drains admitted parallel operations and survives restart without replaying side effects", async () => {
  const home = await tempHome();
  const hostScript = fileURLToPath(new URL("./fixtures/bridge-host.ts", import.meta.url));
  let host = spawnHost(hostScript, home.path);
  let observed: Awaited<ReturnType<typeof watch>> | undefined;
  let client: Awaited<ReturnType<typeof connectAsOwner>> | undefined;
  try {
    await host.ready();
    const owner = client = await connectAsOwner(home.path);
    observed = await watch(home.path);
    const { seen } = observed;
    const { run } = await owner.call(workflowStart, { file: fileURLToPath(new URL("./fixtures/bridge-keys-script.js", import.meta.url)) });
    await eventually(
      () => ["a", "b"].every((name) => counter(home.path, `w1.hold.${name}`).count() === 1),
      20_000,
      "both calls were admitted",
    );
    const requests = await Promise.all([owner.call(workflowPause, { run }), owner.call(workflowPause, { run })]);
    const pause = requests[0].manualPause?.id;
    expect(pause).toBeDefined();
    expect(requests.map((status) => status.manualPause)).toEqual([
      { id: pause!, state: "requested" },
      { id: pause!, state: "requested" },
    ]);

    gate(home.path, "w1.hold.b").open();
    const count = (key: string) => seen.filter((row) => row.type === "niwa.step.intent" &&
      (row.data as { key: string }).key.startsWith(key)).length;
    await eventually(() => count("manual-pause:") === 1, 10_000, "run reaches the boundary");
    expect((await owner.call(workflowInspect, { run })).status.manualPause?.state).toBe("requested");
    expect(count("p1.1.call-2")).toBe(0);

    gate(home.path, "w1.hold.a").open();
    expect((await owner.call(workflowWait, { run, timeoutMs: 5_000 })).manualPause).toEqual({ id: pause!, state: "paused" });
    expect(count("p1.0.call-2")).toBe(0);
    expect(count("p1.1.call-2")).toBe(0);

    await host.kill();
    await owner.close().catch(() => {});
    host = spawnHost(hostScript, home.path);
    await host.ready();
    const again = client = await connectAsOwner(home.path);
    expect((await again.call(workflowInspect, { run })).status.manualPause?.id).toBe(pause);
    expect((await again.call(workflowContinue, { run, pause: "stale" })).manualPause?.id).toBe(pause);
    const continued = await again.call(workflowContinue, { run, pause: pause! });
    expect(continued.manualPause).toBeUndefined();

    expect((await again.call(workflowWait, { run, timeoutMs: 10_000 })).outcome?.status).toBe("done");
    expect(["a", "b"].map((name) => counter(home.path, `w1.hold.${name}`).count())).toEqual([1, 1]);
    expect(count("manual-pause:")).toBe(1);
  } finally {
    await observed?.stop();
    await client?.close().catch(() => {});
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

test("an answered question stays recorded while its workflow is manually paused", async () => {
  const home = await tempHome();
  const host = spawnHost(fileURLToPath(new URL("./fixtures/bridge-host.ts", import.meta.url)), home.path);
  let observed: Awaited<ReturnType<typeof watch>> | undefined;
  let owner: Awaited<ReturnType<typeof connectAsOwner>> | undefined;
  try {
    await host.ready();
    owner = await connectAsOwner(home.path);
    observed = await watch(home.path);
    const { seen } = observed;
    const file = join(home.path, "ask.js");
    await writeFile(file, `export default workflow({ output: z.boolean() }, async () => await ask.confirm("Go on?"));`);
    const { run } = await owner.call(workflowStart, { file });
    await eventually(
      () => seen.some((row) => row.type === "niwa.invocation.state" &&
        (row.data as { state: string }).state === "waiting"),
      15_000,
      "the run should park on its question",
    );
    const asked = RequestCreated.schema.parse(seen.find((row) => row.type === "request.created")?.data);
    const status = await owner.call(workflowPause, { run });
    expect(status.requests).toEqual([asked.id]);
    expect(status.state).toBe("paused");

    await owner.call(requestAnswer, { id: asked.id, answer: { ids: ["yes"] } });
    await eventually(
      () => seen.some((row) => row.type === "niwa.step.intent" &&
        (row.data as { key: string }).key.startsWith("manual-pause:")),
      10_000,
      "the answer should wake the invocation, which should stop at the pause boundary",
    );
    expect(seen.some((row) => row.type === "workflow.run.finished")).toBe(false);
    expect((await owner.call(workflowInspect, { run })).status.requests).toEqual([]);

    await owner.call(workflowContinue, { run, pause: status.manualPause!.id });
    expect((await owner.call(workflowWait, { run, timeoutMs: 10_000 })).outcome).toEqual({
      status: "done",
      result: true,
    });
    expect(seen.filter((row) => row.type === "request.created")).toHaveLength(1);
  } finally {
    await observed?.stop();
    await owner?.close().catch(() => {});
    await host.kill().catch(() => {});
    await home.cleanup();
  }
}, 45_000);

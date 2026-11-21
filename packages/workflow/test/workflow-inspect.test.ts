import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { action, grant, principalOf, seq, shortRun } from "@niwa-labs/core";
import { harnessId, harnessKind, machineId, sessionId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { plugin } from "@niwa-labs/plugin";
import { SessionStarted, sessionRef } from "@niwa-labs/sessions/records";
import { connect, createNiwa, sessions, eventually, tempHome } from "@niwa-labs/testing";
import { workflow, workflowInspect, workflowResume, workflowStart, workflowWait } from "../src/index.ts";
import { z } from "zod";

test("inspect shows the declared phases with their states and steps, and links parallel steps to their own nested sessions", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  const harness = harnessId("inspect-test");
  const held = Promise.withResolvers<void>();
  const asked = new Map<string, ReturnType<typeof sessionId>>();
  let launches = 0;
  const control: SessionControl = {
    start: async () => ({ session: sessionId(harness, `launch-${++launches}`) }),
    resume: async () => {},
    send: async () => ({ status: "started", turn: 1 }),
    interrupt: async () => {},
    ask: async <T>(session: Parameters<SessionControl["ask"]>[0], options: Parameters<SessionControl["ask"]>[1]) => {
      const prompt = options.prompt.sections.map((section) => section.text).join("");
      asked.set(prompt, session);
      if (prompt === "left") await held.promise;
      return { session, value: options.schema.parse({ answer: prompt }) as T, at: 0 as never };
    },
    life: async function* () {},
    state: async () => "unknown",
  };
  const instance: Harness = {
    id: harness,
    kind: harnessKind("inspect-fake"),
    machine: machineId("inspect-machine"),
    home: home.path,
    sides: {
      reading: { list: true, read: true, watch: false },
      control: { start: true, resume: false, send: true, interrupt: true, ask: true, structuredOutput: true, launch: { model: false, effort: [], modes: [] } },
    },
  };
  host.use(sessions({ harnesses: [{ instance, control }] }), workflow({ harnesses: [harness] }));
  try {
    await host.serve();
    const file = join(home.path, "inspect.js");
    await writeFile(file, `export default workflow({ phases: [{ title: "sample" }, { title: "agents", detail: "two at once" }, { title: "review" }] }, async () => {
      await now({ label: "before" });
      for (let n = 0; n < 2; n++) {
        phase("sample");
        await now({ label: "sample-" + n });
      }
      phase("agents");
      await parallel([
        () => agent("left", { harness: "inspect-test" }),
        () => agent("right", { harness: "inspect-test" }),
      ]);
    });`);
    const { run } = await host.call(workflowStart, { file, label: "inspection" });
    const inspect = () => host.call(workflowInspect, { run: shortRun(run) });
    await eventually(async () => (await inspect()).phases[1]?.steps.some((step) => step.prompt === "right" && step.status === "completed") === true, 15_000);
    const found = await inspect();
    expect(found.run).toBe(run);
    expect(found.origin).toMatchObject({ file, label: "inspection", requestedAt: expect.any(String), startedAt: expect.any(String) });
    expect(found.origin.finishedAt).toBeUndefined();
    expect(found.status.state).toBe("running");
    expect(found.steps.map((step) => step.label)).toEqual(["before"]);
    expect(found.phases.map(({ title, detail, state }) => ({ title, detail, state }))).toEqual([
      { title: "sample", detail: undefined, state: "done" },
      { title: "agents", detail: "two at once", state: "current" },
      { title: "review", detail: undefined, state: "ahead" },
    ]);
    expect(found.status.phases?.map((phase) => phase.state)).toEqual(["done", "current", "ahead"]);
    expect(found.status.currentPhases).toEqual(["agents"]);
    expect(found.phases[0]?.steps.map((step) => [step.label, step.phase])).toEqual([["sample-0", "sample"], ["sample-1", "sample"]]);
    expect(found.phases[2]?.steps).toEqual([]);

    const started = (await host.records.read()).filter((row) => row.type === SessionStarted.name).map((row) => SessionStarted.schema.parse(row.data));
    const sessionFor = (prompt: string) => {
      const session = asked.get(prompt);
      return session === undefined ? undefined : started.find((record) => record.session === sessionRef(session))?.id;
    };
    expect(sessionFor("left")).toBeDefined();
    expect(sessionFor("right")).toBeDefined();
    expect(sessionFor("left")).not.toBe(sessionFor("right"));
    const steps = found.phases[1]?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps.find((step) => step.prompt === "left")).toMatchObject({ branch: "p1.0", action: "session.start.inspect-test", status: "running", session: sessionFor("left") });
    expect(steps.find((step) => step.prompt === "right")).toMatchObject({ branch: "p1.1", action: "session.start.inspect-test", status: "completed", endedAt: expect.any(String), session: sessionFor("right") });

    held.resolve();
    await host.call(workflowWait, { run, timeoutMs: 15_000 });
    const completed = await inspect();
    expect(completed.status).toMatchObject({ state: "finished", outcome: { status: "done" } });
    expect(completed.origin.finishedAt).toBeDefined();
    // A run that finished with its result has done every phase it reached; the one it never reached is still ahead.
    expect(completed.phases.map((phase) => phase.state)).toEqual(["done", "done", "ahead"]);
  } finally {
    held.resolve();
    await host.close();
    await home.cleanup();
  }
}, 30_000);

test("inspect uses run ownership and reports a skipped step without a session", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  const fail = action("inspect.fail", {
    description: "Fail an inspected step.",
    input: z.object({}),
    output: z.object({}),
    recovery: "repeat",
    effect: "write",
    run: () => { throw new Error("expected failure"); },
  });
  host.use(plugin("inspect", (api) => api.action(fail)), workflow());
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
  try {
    await host.serve();
    for (const name of ["starter", "other"]) {
      const token = host.issueToken(principalOf("session", name), { grant: grant(["workflow.inspect", "workflow.start", "inspect.fail"]) });
      clients.push(await connect({ home: home.path, id: `session:${name}`, token }));
    }
    const [starter, other] = clients;
    if (starter === undefined || other === undefined) throw new Error("clients did not connect");
    const file = join(home.path, "pause.js");
    await writeFile(file, `export default workflow({ uses: ["inspect.fail"], phases: [{ title: "check" }] }, async () => {
      phase("check");
      await call("inspect.fail", {}, { label: "fails" });
    });`);
    const { run } = await starter.call(workflowStart, { file });
    await host.call(workflowWait, { run, timeoutMs: 15_000 });
    await expect(other.call(workflowInspect, { run })).rejects.toThrow("whoever made it");
    const paused = await starter.call(workflowInspect, { run });
    expect(paused.status.state).toBe("paused");
    expect(paused.phases[0]).toMatchObject({ title: "check", state: "current" });
    expect(paused.phases[0]?.steps).toMatchObject([{ key: "label:fails", label: "fails", action: "inspect.fail", status: "failed", endedAt: expect.any(String) }]);
    expect(paused.phases[0]?.steps[0]?.session).toBeUndefined();

    await host.call(workflowResume, { run, choice: "skip" });
    await eventually(async () => (await host.call(workflowInspect, { run })).status.state === "finished", 15_000);
    const finished = await host.call(workflowInspect, { run });
    expect(finished.phases[0]?.steps).toMatchObject([{ key: "label:fails", status: "skipped", endedAt: expect.any(String) }]);
    expect(finished.phases[0]?.state).toBe("done");
  } finally {
    for (const client of clients) await client.close();
    await host.close();
    await home.cleanup();
  }
}, 30_000);

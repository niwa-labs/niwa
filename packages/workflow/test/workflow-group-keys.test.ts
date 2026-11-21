// Two groups of branches in one script do not share keys.
//
// A script that runs one `parallel` after another, or a `parallel` in a loop, makes groups whose
// branches are numbered from zero each time: the keys of the second group must not be the keys
// of the first, or its calls are answered with the answers of the first.
//
// The scenario runs against a real host process (test/fixtures/revision-host.ts).

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { counter, eventually, spawnHost, tempHome, watch, connectAsOwner } from "@niwa-labs/testing";
import { z } from "zod";


const HOST_SCRIPT = fileURLToPath(new URL("./fixtures/revision-host.ts", import.meta.url));
const RunOutput = z.object({ run: z.string(), finished: z.boolean() });

test("two groups of branches in one script have keys of their own", async () => {
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

    const script = `${homePath}/branches-groups.js`;
    await Bun.write(
      script,
      [
        'export default workflow({ uses: ["revision.agent"], output: z.json() }, async () => {',
        '  const one = await parallel([() => agent("a1"), () => agent("a2")]);',
        '  const two = await parallel([() => agent("b1"), () => agent("b2")]);',
        '  const three = await pipeline([() => agent("c1"), (previous) => agent("c2 " + previous.answer)]);',
        '  const four = await pipeline([() => agent("d1"), () => agent("d2")]);',
        "  return { one, two, three, four };",
        '});',
        "",
      ].join("\n"),
    );
    RunOutput.parse(await client.call("workflow.start" as never, { file: script } as never));
    await eventually(() => seen.some((r) => r.type === "workflow.run.finished" || r.type === "niwa.invocation.state" && (r.data as { state?: string }).state === "paused"), 30_000, "the run should end");

    const finished = seen.find((r) => r.type === "workflow.run.finished");
    expect(finished).toBeDefined();
    const answer = (text: string) => ({ answer: `answered: ${text}` });
    expect((finished?.data as { outcome?: { result?: unknown } }).outcome?.result).toEqual({
      one: [answer("a1"), answer("a2")],
      two: [answer("b1"), answer("b2")],
      three: [answer("c1"), answer("c2 answered: c1")],
      four: [answer("d1"), answer("d2")],
    });
    // Eight calls, eight keys; the hold of the grant on each call is a step of its own, under `<key>~auth`.
    const keys = seen
      .filter((r) => r.type === "niwa.step.intent")
      .map((r) => (r.data as { key?: string }).key)
      .filter((key) => !key?.endsWith("~auth"));
    expect(new Set(keys).size).toBe(8);
    expect(counter(homePath, "revision.agent").count()).toBe(8);
    await client.close().catch(() => {});
  } finally {
    await observer?.stop();
    await host?.kill().catch(() => {});
    await home.cleanup();
  }
}, 60_000);

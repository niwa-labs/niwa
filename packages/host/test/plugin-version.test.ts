// The version of a plugin and moving work between versions.
//
//   1. the default version covers the handlers' source, also when a handler is defined outside the
//      setup function; the same code is the same version, and an explicit version is kept
//   2. a restart onto changed code does not move unfinished work: it pauses as "plugin version
//      unavailable"; the explicit move runs it on the installed version, and it ends as done

import { expect, test } from "bun:test";

import { MOVE_ACTION, record, seq } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin, withoutHandler } from "@niwa-labs/plugin";
import type { Handler, StoredRecord } from "@niwa-labs/core";
import { eventually, tempHome, STATE_TYPE } from "@niwa-labs/testing";
import { z } from "zod";

const Start = record("pv.start", z.object({ n: z.number() }));
const Answer = record("pv.answer", z.object({ n: z.number() }));
const Done = record("pv.done", z.object({ n: z.number(), by: z.string() }));

const sink: string[] = [];

/** The same setup text twice; only the handler it is given differs. */
function pluginWith(handler: () => void, version?: string) {
  return plugin(
    "pv-shape",
    (api) => {
      api.declare(Start);
      api.on(Start, handler);
    },
    version === undefined ? {} : { version },
  );
}

const handlerOne = () => {
  sink.push("one");
};
const handlerOneAgain = () => {
  sink.push("one");
};
const handlerTwo = () => {
  sink.push("two");
};

/** The version a plugin carries once it is installed: the setup has run and the handlers are known. */
async function installedVersion(made: ReturnType<typeof pluginWith>): Promise<string> {
  const home = await tempHome();
  try {
    createNiwa({ home: home.path }).use(made);
    return String(made.version);
  } finally {
    await home.cleanup();
  }
}

test("the default version covers a handler defined outside the setup function", async () => {
  const one = await installedVersion(pluginWith(handlerOne));
  expect(await installedVersion(pluginWith(handlerOneAgain))).toBe(one);
  expect(await installedVersion(pluginWith(handlerTwo))).not.toBe(one);
});

test("an explicit version is kept whatever the code is", async () => {
  expect(await installedVersion(pluginWith(handlerOne, "r1"))).toBe("r1");
  expect(await installedVersion(pluginWith(handlerTwo, "r1"))).toBe("r1");
});

/** The handlers of the two versions of one plugin: the setup text is the same, the code is not. */
const finishOld: Handler<z.infer<typeof Start.schema>> = async (data, step) => {
  await step.wait(Answer, (answer) => answer.n === data.n, { key: "answer" });
  await step.emit(Done, { n: data.n, by: "old" });
};
const finishNew: Handler<z.infer<typeof Start.schema>> = async (data, step) => {
  await step.wait(Answer, (answer) => answer.n === data.n, { key: "answer" });
  await step.emit(Done, { n: data.n, by: "new" });
};

function worker(handler: Handler<z.infer<typeof Start.schema>>) {
  return plugin("pv-work", (api) => {
    api.declare(Start, Answer, Done);
    api.on(Start, handler);
  });
}

function statesOf(records: StoredRecord[]): Array<{ state: string; reason?: string; choices?: string[] }> {
  return records
    .filter((r) => r.type === STATE_TYPE)
    .map((r) => r.data as { state: string; reason?: string; choices?: string[] });
}

test("a restart onto changed code pauses unfinished work; only the explicit move runs it on the new code", async () => {
  const home = await tempHome();
  try {
    const first = createNiwa({ home: home.path });
    first.use(worker(finishOld));
    await first.serve();
    await first.emit(Start, { n: 1 });
    await eventually(
      async () => statesOf(await first.records.read(seq(0))).at(-1)?.state === "waiting",
      10_000,
      "the invocation does not wait",
    );
    await first.close();

    const second = createNiwa({ home: home.path });
    const next = worker(finishNew);
    second.use(next);
    await second.serve();
    try {
      await eventually(
        async () => statesOf(await second.records.read(seq(0))).at(-1)?.state === "paused",
        10_000,
        "the invocation is not paused",
      );
      const paused = statesOf(await second.records.read(seq(0))).at(-1);
      expect(paused?.reason).toContain("plugin version unavailable");
      expect(paused?.choices).toEqual(["cancel"]);

      // The answer arrives, and the restart has still not moved anything.
      await second.emit(Answer, { n: 1 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await second.records.read(seq(0), { type: Done })).toHaveLength(0);

      const admitted = (await second.records.read(seq(0))).find((r) => r.type === "niwa.invocation.admitted");
      const invocation = (admitted?.data as { invocation: string }).invocation;
      const moved = await second.call<{ invocation: string }, { from: string; to: string }>(
        MOVE_ACTION,
        { invocation },
      );
      expect(moved.to).toBe(String(next.version));
      expect(moved.from).not.toBe(moved.to);

      await eventually(
        async () => (await second.records.read(seq(0), { type: Done })).length === 1,
        10_000,
        "the moved invocation did not finish",
      );
      const [done] = await second.records.read(seq(0), { type: Done });
      expect(done?.data).toEqual({ n: 1, by: "new" });
      expect(statesOf(await second.records.read(seq(0))).at(-1)?.state).toBe("done");
      await expect(second.call(MOVE_ACTION, { invocation })).rejects.toThrow("done");
    } finally {
      await second.close();
    }
  } finally {
    await home.cleanup();
  }
}, 60_000);

const Spare = record("pv.spare", z.object({}));
const spareHandler = () => {};

function twoHandlers(handler: () => void) {
  return plugin("pv-two", (api) => {
    api.declare(Start, Spare);
    api.on(Start, handler);
    api.on(Spare, spareHandler);
  });
}

test("a plugin without a handler carries the version of its source code, handlers outside the setup included", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    const versionOf = (made: ReturnType<typeof twoHandlers>) => {
      const without = withoutHandler(made, Spare.name);
      niwa.use(without);
      return String(without.version);
    };
    const one = versionOf(twoHandlers(handlerOne));
    expect(versionOf(twoHandlers(handlerOneAgain))).toBe(one);
    expect(versionOf(twoHandlers(handlerTwo))).not.toBe(one);

    // The source installed whole and then taken without the handler is the same code, the same version.
    const whole = twoHandlers(handlerOne);
    niwa.use(whole);
    expect(String(withoutHandler(whole, Spare.name).version)).toBe(one);
  } finally {
    await home.cleanup();
  }
});

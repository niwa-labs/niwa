// Services: work a plugin runs while the host serves.
//
// A service starts when the host serves, is replaced with its plugin, and stops when the plugin is
// unloaded or the host closes. Triggers (record types with a filter) wake a handler only for the
// records that pass the filter, and cannot be declared.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Ping = record("svc.ping", z.object({ who: z.string() }));

/** A plugin whose service records its starts and stops. */
function watched(log: string[], label: string) {
  return plugin(
    "watched",
    (api) => {
      api.service(() => {
        log.push(`start:${label}`);
        return () => {
          log.push(`stop:${label}`);
        };
      });
    },
    { version: label },
  );
}

test("a service starts when the host serves and stops when the host closes", async () => {
  const home = await tempHome();
  const log: string[] = [];
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(watched(log, "a"));
    expect(log).toEqual([]);
    await niwa.serve();
    expect(log).toEqual(["start:a"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
  expect(log).toEqual(["start:a", "stop:a"]);
});

test("a service stops when its plugin is unloaded, and is replaced with its plugin", async () => {
  const home = await tempHome();
  const log: string[] = [];
  const niwa = createNiwa({ home: home.path });
  try {
    await niwa.serve();
    niwa.use(watched(log, "a"));
    niwa.use(watched(log, "b"));
    expect(log).toEqual(["start:a", "stop:a", "start:b"]);
    niwa.unload(watched(log, "x").name);
    expect(log).toEqual(["start:a", "stop:a", "start:b", "stop:b"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
  // Closing stops nothing that was already stopped.
  expect(log).toEqual(["start:a", "stop:a", "start:b", "stop:b"]);
});

test("a stopped service cannot write", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  let emit: ((who: string) => Promise<unknown>) | undefined;
  try {
    const writer = plugin("writer", (api) => {
      api.declare(Ping);
      api.service((ctx) => {
        emit = (who) => ctx.emit(Ping, { who });
        return () => {};
      });
    });
    niwa.use(writer);
    await niwa.serve();
    await emit?.("alive");
    niwa.unload(writer.name);
    await expect(emit?.("late")).rejects.toThrow("has stopped");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a trigger is not declared, and a filtered handler is woken only by the records that pass", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  const woken: string[] = [];
  const onlyAnna = { ...Ping, filter: (data: unknown) => (data as { who: string }).who === "anna", handlerId: "svc.ping:anna" };
  try {
    expect(() =>
      niwa.use(plugin("bad", (api) => api.declare(onlyAnna))),
    ).toThrow("is a trigger");
    let emit: ((who: string) => Promise<unknown>) | undefined;
    niwa.use(
      plugin("source", (api) => {
        api.declare(Ping);
        api.service((ctx) => {
          emit = (who) => ctx.emit(Ping, { who });
          return () => {};
        });
      }),
    );
    niwa.use(
      plugin("sink", (api) => {
        api.on(onlyAnna, (data: { who: string }) => {
          woken.push(data.who);
        });
      }),
    );
    await niwa.serve();
    await emit?.("bob");
    await emit?.("anna");
    await emit?.("carl");
    for (let i = 0; i < 100 && woken.length === 0; i++) await Bun.sleep(20);
    await Bun.sleep(100);
    expect(woken).toEqual(["anna"]);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

const ownerPlugin = (type: typeof Ping) =>
  plugin("watcher", (api) => {
    api.on({ ...type, filter: () => true, handlerId: "svc.ping:all" }, () => {});
  });

test("serve refuses a trigger whose type nobody declares, and the timer trigger names the timers plugin", async () => {
  const { timer, timers } = await import("@niwa-labs/timer");
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(ownerPlugin(Ping));
    await expect(niwa.serve()).rejects.toThrow(/watcher.*svc\.ping.*no installed plugin declares it/);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
  // The name the trigger gives for the provider is the name the timer plugin really has.
  const daily = timer.daily("09:00");
  const home2 = await tempHome();
  const bare = createNiwa({ home: home2.path });
  try {
    bare.use(plugin("sink", (api) => api.on(daily, () => {})));
    await expect(bare.serve()).rejects.toThrow(/"timers" plugin is not installed/);
    expect(String(timers([daily]).name)).toBe(daily.provider ?? "");
  } finally {
    await bare.close();
    await home2.cleanup();
  }
});

test("a trigger of a type the core writes is not refused, and a plugin installed while serving is not checked", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(
      plugin("core-watcher", (api) => {
        api.on({ ...record("niwa.invocation.state", z.object({})), filter: () => true, handlerId: "core:state" }, () => {});
      }),
    );
    await niwa.serve();
    // Hot install is not refused: a later plugin may still declare what it waits for.
    niwa.use(ownerPlugin(Ping));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

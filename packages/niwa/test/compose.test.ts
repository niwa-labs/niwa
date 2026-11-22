// What the package composes: the plugins a composition file exports, the port of `niwa web`, the
// kinds that read skills, and the names the package re-exports.

import { expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { openBoxes, tempHome } from "@niwa-labs/testing";

import * as niwa from "../src/index.ts";
import { pluginsOf } from "../src/serve.ts";
import { portOf } from "../src/web.ts";

test("a composition exports plugins as a default, as named exports or as arrays, in the order of the exports", () => {
  const one = plugin("one", () => {});
  const two = plugin("two", () => {});
  const three = plugin("three", () => {});
  expect(pluginsOf({ default: [one, two], three, unrelated: 1, nothing: null }).map((found) => String(found.name))).toEqual(["one", "two", "three"]);
  expect(pluginsOf({ answer: 42 })).toEqual([]);
});

test("niwa web takes no port, --port N or --port=N, and refuses anything else", () => {
  expect(portOf([])).toBe(0);
  expect(portOf(["--port", "8080"])).toBe(8080);
  expect(portOf(["--port=0"])).toBe(0);
  expect(portOf(["--port", "70000"])).toBeUndefined();
  expect(portOf(["--port", "1.5"])).toBeUndefined();
  expect(portOf(["--port"])).toBeUndefined();
  expect(portOf(["8080"])).toBe(8080);
  expect(portOf(["--port", "1", "2"])).toBeUndefined();
});

test("the kinds that read skills are the seven harness kinds that have a place for them", () => {
  expect(niwa.KINDS_WITH_SKILLS.map((skills) => skills.kind)).toEqual(["claude-code", "codex", "mcode", "ncode", "opencode", "pi", "zcode"]);
});

test("the package re-exports the foundation, the plugins and the kinds", () => {
  for (const name of ["createNiwa", "connect", "plugin", "action", "sessions", "workflow", "requests", "claudeCode", "codex", "pi", "serveComposition", "NIWA_CLI"]) {
    expect(name in niwa).toBe(true);
  }
});

test("the default composition holds the base plugins with history and the agents, and a host serves it", async () => {
  const home = await tempHome();
  try {
    const plugins = niwa.defaultComposition({ home: home.path, harnesses: new niwa.HarnessInstanceRegistry(), agents: { default: "rin" } });
    expect(plugins.map((one) => String(one.name))).toEqual(["messages", "requests", "tasks", "timers", "git", "history", "insert", "sessions", "proc", "box", "agents", "workflow"]);
    const host = createNiwa({ home: home.path });
    host.use(...plugins);
    await host.serve();
    try {
      const names = (await host.describe()).actions.map((action) => String(action.name));
      for (const name of ["history.list", "history.read", "history.search", "history.watch", "history.signal", "insert.report", "agent.attach", "agent.tell", "workflow.start"]) expect(names).toContain(name);
    } finally {
      await host.close();
    }
  } finally {
    await home.cleanup();
  }
}, 60_000);

test("a proc.run of the default composition finds every harness installation's places closed, and takes the box the host gives", async () => {
  const home = await tempHome();
  try {
    const codexHome = join(home.path, "codex-home");
    mkdirSync(codexHome);
    const kinds = new niwa.HarnessKindRegistry();
    kinds.register(niwa.codexKind);
    const harnesses = new niwa.HarnessInstanceRegistry(kinds);
    harnesses.register(niwa.codexKind.bind({ id: "codex-luna", home: codexHome }));
    const plugins = niwa.defaultComposition({ home: join(home.path, "niwa"), harnesses, sandbox: openBoxes(), box: { proc: { allow: ["git"] } } });
    const host = createNiwa({ home: join(home.path, "niwa") });
    host.use(...plugins);
    await host.serve();
    try {
      const work = join(home.path, "work");
      mkdirSync(work);
      const result = (await host.call(niwa.procRun.name, { cmd: ["/usr/bin/true"], cwd: work, timeout: 10_000 })) as { box: { closed: unknown[]; request: unknown } };
      expect(result.box.closed).toContainEqual({ path: realpathSync(codexHome), from: "harness:codex-luna" });
      expect(result.box.request).toEqual({ mode: "allow", items: [{ item: "git", from: "host" }] });
    } finally {
      await host.close();
    }
  } finally {
    await home.cleanup();
  }
}, 60_000);

test("the host composition installs separate outbound profiles and keeps the network-off policy", async () => {
  const home = await tempHome();
  try {
    const work = join(home.path, "work");
    mkdirSync(work);
    const primary = join(home.path, "primary");
    const second = join(home.path, "second");
    const loopback = { host: "127.0.0.1", port: 0 } as const;
    const harnesses = new niwa.HarnessInstanceRegistry();
    harnesses.register(niwa.codexKind.bind({
      id: "codex-primary", home: primary, boxProfile: { net: ["proxy.example.com"], listen: loopback },
    }));
    harnesses.register(niwa.codexKind.bind({
      id: "codex-secondary", home: second, boxProfile: { net: [] },
    }));
    const boxes = openBoxes();
    niwa.defaultComposition({ home: home.path, harnesses, sandbox: boxes });

    const plan = (owner: string, network: boolean) => boxes.plan({ cwd: work, defaults: { allow: [] }, owner, network });
    const replacements = plan("codex-primary", true);
    expect(replacements.net).toEqual([{ host: "proxy.example.com", from: "harness:codex-primary" }]);
    expect(replacements.listen).toEqual({ ...loopback, from: "harness:codex-primary" });
    expect(replacements.closed).toContainEqual({ path: join(realpathSync(home.path), "second"), from: "harness:codex-secondary" });
    expect(plan("codex-secondary", true).net).toEqual([]);
    const offline = plan("codex-primary", false);
    expect(offline.net).toEqual([]);
    expect(offline.listen).toBeUndefined();
    expect(offline.refusals.map((refusal) => refusal.code)).toContain("no-network");
    expect(offline.skipped).toContainEqual({ place: "proxy.example.com", from: "harness:codex-primary", why: "this box reaches no network" });
  } finally {
    await home.cleanup();
  }
});

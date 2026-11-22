import { expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { promptFromText, sessionId, Unsupported } from "@niwa-labs/harness";
import { admit, BoxRefused, onSpawn, resolveProfile, sandbox } from "@niwa-labs/sandbox";
import type { Sandbox } from "@niwa-labs/sandbox";
import { tempDir, unconfined } from "@niwa-labs/testing";

import { opencode, opencodeKind } from "../src/index.ts";
import { opencodeWorker } from "../src/runtime.ts";

test("the profile grants just the installation's OpenCode XDG directories", () => {
  const root = join(process.cwd(), "test-xdg-profile");
  const home = join(root, "home");
  const data = join(root, "custom-data", "opencode");
  const binding = opencode({
    home: data,
    control: {
      binary: join(root, "missing-opencode"),
      env: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: join(root, "custom-state"), OPENCODE_CONFIG_DIR: root },
    },
  });
  const profile = resolveProfile(binding.profile!, binding.instance.id, {
    home,
    env: {
      XDG_DATA_HOME: join(root, "unused-data"),
      XDG_CONFIG_HOME: join(root, "unused-config"),
      XDG_STATE_HOME: join(root, "unused-state"),
      XDG_CACHE_HOME: join(root, "machine-cache"),
    },
  });
  expect(profile.write).toEqual([
    data,
    join(home, ".config", "opencode"),
    join(root, "custom-state", "opencode"),
    join(root, "machine-cache", "opencode"),
  ]);
  expect(profile.read).toContain(process.execPath);
  expect(profile.read).toEqual(expect.arrayContaining([opencodeWorker().root]));
  expect(profile.programs).not.toContain(opencodeWorker().root);
  expect(profile.net).toEqual([]);
  expect(profile.listen).toBeUndefined();
});

test("boxed starts and cold resumes require writable OpenCode state before spawning", async () => {
  const binding = opencode({ home: "/missing-opencode-state/opencode", control: { binary: "/missing-opencode" } });
  const control = binding.control!;
  const onLaunch = mock(() => {});
  const available = mock(async () => false);
  const box = { sandbox: { ...unconfined(), available }, spec: { cwd: process.cwd() } };
  const stop = onSpawn((event) => {
    if (event.harness === binding.instance.id) onLaunch();
  });

  try {
    expect(opencodeKind.profile.status).toBe("admitted");
    const id = sessionId(binding.instance.id, "ses_existing");
    for (const ability of ["start", "resume"] as const) {
      const tried = ability === "start" ? control.start({ prompt: promptFromText(""), box }) : control.resume(id, { box });
      await expect(tried).rejects.toBeInstanceOf(Unsupported);
      await expect(tried).rejects.toThrow(/lacks writable OpenCode paths/);
    }
    expect(available).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  } finally {
    stop();
    await control.dispose?.();
  }
});

test("the boxed worker reopens its SQLite session and does not use the configured CLI or a listener", async () => {
  const root = await tempDir("opencode-pipe");
  const work = join(root, "work");
  const tmp = join(root, "tmp");
  const home = join(root, "data", "opencode");
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: "test-opencode.db",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  };
  const binding = opencode({ home, control: { binary: "/missing-opencode", env, callTimeoutMs: 5_000 } });
  const control = binding.control!;
  const standIn = unconfined();
  const launch = mock(standIn.launch);
  const adapter = { ...standIn, launch };
  const boxes = sandbox({ adapter });
  boxes.install(binding.instance.id, binding.profile!);
  try {
    await Promise.all([mkdir(work), mkdir(tmp)]);
    const plan = boxes.plan({ cwd: work, owner: binding.instance.id, defaults: { allow: [] }, writes: [{ path: tmp, from: "temp" }], network: true });
    const { spec } = admit(plan, adapter, () => undefined, { env: { TMPDIR: tmp } });
    const box = { sandbox: adapter, spec };
    const { session } = await control.start({ cwd: work, prompt: promptFromText(""), box });
    await control.close?.(session);
    expect(await Bun.file(join(home, env.OPENCODE_DB)).exists()).toBe(true);
    await control.resume(session, { cwd: work, box });
    expect(await control.state(session)).toBe("idle");
    expect(launch).toHaveBeenCalledTimes(2);
    for (const [actual, argv] of launch.mock.calls) {
      expect(actual.listen).toBeUndefined();
      expect(actual.net).toEqual([]);
      expect(actual.env).toMatchObject({ ...env, TMPDIR: tmp, XDG_DATA_HOME: join(root, "data") });
      expect(argv).toEqual([process.execPath, ...opencodeWorker().args]);
    }
  } finally {
    await control.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a test adapter receives the declared endpoint and scoped XDG environment on start and resume", async () => {
  const root = await tempDir("opencode-box-plan");
  const work = join(root, "work");
  const tmp = join(root, "tmp");
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const fixture = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const endpoint = { host: "127.0.0.1", port: portProbe.port } as const;
  await portProbe.stop(true);
  const binding = opencode({ home: join(root, "data", "opencode"), boxProfile: { listen: endpoint }, control: { binary: process.execPath, env } });
  const control = binding.control!;
  const standIn = unconfined();
  const launch = mock<typeof standIn.launch>((spec, [program, ...args], options) => standIn.launch(spec, [program!, fixture, ...args], options));
  const adapter: Sandbox = {
    ...standIn,
    manifest: (spec) => {
      const base = standIn.manifest(spec);
      const { host, port } = spec.listen!;
      return { ...base, policy: { ...base.policy!, listen: { host, port } } };
    },
    launch,
  };
  const boxes = sandbox({ adapter });
  boxes.install(binding.instance.id, binding.profile!);
  try {
    await mkdir(work, { recursive: true });
    const plan = boxes.plan({ cwd: work, owner: binding.instance.id, defaults: { allow: [] }, writes: [{ path: tmp, from: "temp" }], network: true });
    const { spec } = admit(plan, adapter, () => undefined, { env: { TMPDIR: tmp } });
    const box = { sandbox: adapter, spec };
    const unproven = { ...standIn, launch };
    await expect(control.start({ prompt: promptFromText(""), box: { sandbox: unproven, spec } })).rejects.toBeInstanceOf(BoxRefused);
    await expect(control.start({ prompt: promptFromText(""), box, env: { XDG_CACHE_HOME: join(root, "other") } })).rejects.toThrow(/lacks writable OpenCode paths/);
    expect(launch).not.toHaveBeenCalled();
    const { session } = await control.start({ prompt: promptFromText(""), box });
    await control.close?.(session);
    await control.resume(session, { box });
    await control.resume(session, { servers: [{ name: "fixture", command: "/missing-mcp", args: [], env: {}, tools: [] }] });
    expect(launch).toHaveBeenCalledTimes(3);
    for (const [spec, argv] of launch.mock.calls) {
      expect(spec.listen).toEqual({ ...endpoint, from: `harness:${binding.instance.id}` });
      expect(spec.env).toMatchObject({ ...env, TMPDIR: tmp, XDG_DATA_HOME: join(root, "data") });
      expect(argv).toEqual([process.execPath, "serve", "--stdio", "--hostname", endpoint.host, "--port", String(endpoint.port)]);
    }
    await control.close?.(session);
    await expect(control.resume(session, { box, env: { FAKE_ANNOUNCED_URL: "http://127.0.0.1:1" } })).rejects.toThrow(/control\.resume.*outside the box's TCP loopback listener/);
  } finally {
    await control.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

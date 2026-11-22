import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discover, harnessId, promptFromText, sessionId } from "@niwa-labs/harness";
import { tempDir } from "@niwa-labs/testing";

import { opencode, opencodeKind } from "../src/index.ts";
import type { OpenCodeSessionControl } from "../src/index.ts";
import { announcementIn } from "../src/server.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));
const prompt = promptFromText("");
let root = "";

beforeEach(async () => {
  root = await tempDir("opencode-binding");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The fixture retains its sessions in cwd, so launch it from the database's directory. */
async function fakeServer(name: string): Promise<string> {
  const binary = join(root, name);
  await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const home = join(process.env.XDG_DATA_HOME, "opencode");
const directory = dirname(resolve(home, process.env.OPENCODE_DB ?? "opencode.db"));
mkdirSync(directory, { recursive: true });
process.chdir(directory);
process.env.FAKE_DATA_DIR = directory;
if (existsSync("sessions.json")) {
  // The control fixture persists only the session ID and working directory.
  const sessions = JSON.parse(readFileSync("sessions.json", "utf8"));
  writeFileSync("sessions.json", JSON.stringify(sessions.map((session) => ({
    ...session,
    projectID: "prj_fake",
    location: { directory: session.directory },
    time: { created: 1, updated: 1 },
  }))));
}
const group = Bun.spawnSync(["/bin/ps", "-p", String(process.pid), "-o", "pgid="]);
appendFileSync("process-groups.log", JSON.stringify({
  pid: process.pid, group: Number(group.stdout.toString().trim())
}) + "\\n");
await import(${JSON.stringify(fixture)});
`, { mode: 0o755 });
  return binary;
}

function storedSession(path: string, native: string): void {
  const database = new Database(path);
  try {
    database.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)");
    database.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)");
    database.query("INSERT INTO session_v2 VALUES (?, NULL, ?, NULL, 1, 1)").run(native, root);
  } finally {
    database.close();
  }
}

test("only local HTTP origins are accepted from a child announcement", () => {
  expect(announcementIn('{"url":"http://127.0.0.1:4000"}')).toBe("http://127.0.0.1:4000");
  expect(announcementIn('{"url":"http://[::1]:4000/"}')).toBe("http://[::1]:4000");
  for (const url of [
    "http://example.invalid:4000",
    "https://127.0.0.1:4000",
    "http://localhost:4000",
    "http://user@127.0.0.1:4000",
    "http://@127.0.0.1:4000",
    "http://127.0.0.1:4000/path",
  ]) {
    expect(announcementIn(JSON.stringify({ url }))).toBeUndefined();
  }
  expect(announcementIn("server loading")).toBeUndefined();
});

test("discovery uses the selected XDG home and executable and ignores v1", async () => {
  const data = join(root, "xdg-data");
  const home = join(data, "opencode");
  const fallbackHome = join(root, ".local", "share", "opencode");
  const override = join(root, "opencode-v2");
  await mkdir(home, { recursive: true });
  await mkdir(fallbackHome, { recursive: true });
  await writeFile(join(root, "opencode"), "#!/bin/sh\necho 1.3.0\n", { mode: 0o755 });
  await writeFile(override, "#!/bin/sh\necho opencode v2.3.2\n", { mode: 0o755 });
  const env = { HOME: root, PATH: root, XDG_DATA_HOME: data };

  const old = await discover([opencodeKind], env);
  expect(old.proposals).toEqual([]);
  expect(old.missing[0]?.reason).toContain('reports "1.3.0"');

  const selected = await discover([opencodeKind], { ...env, OPENCODE_BIN: override });
  expect(selected.missing).toEqual([]);
  expect(selected.proposals).toEqual([{
    kind: "opencode",
    binary: { path: override, version: "opencode v2.3.2" },
    home,
  }]);

  const fallback = await discover([opencodeKind], { ...env, XDG_DATA_HOME: "", OPENCODE_BIN: override });
  expect(fallback.proposals[0]?.home).toBe(fallbackHome);
});

test("a binding uses the detected executable for control and reads history without launching it", async () => {
  const binary = await fakeServer("detected-opencode");
  const home = join(root, "opencode");
  const binding = opencode({
    binary: { path: binary, version: "opencode v2.3.2" },
    home,
    control: { stopGraceMs: 300 },
  });
  const profile = binding.profile;
  expect(typeof profile).toBe("function");
  if (typeof profile !== "function" || binding.reading === undefined) throw new Error("incomplete binding");
  expect(profile({ home: homedir(), env: {}, bin: (name) => [name] }).read).toEqual([binary]);
  const control = binding.control as OpenCodeSessionControl;
  try {
    const { session } = await control.start({ prompt });
    await control.close(session);
    storedSession(join(home, "opencode.db"), session.native);
    expect((await binding.reading.coverage(session)).status).toBe("empty");
    const processes = (await readFile(join(home, "process-groups.log"), "utf8")).trim().split("\n");
    expect(processes).toHaveLength(1);
    for (const line of processes) {
      const { pid, group } = JSON.parse(line) as { pid: number; group: number };
      expect(group).toBe(pid);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    await control.dispose();
  }
});

test("an explicit executable and database override are shared, and a session cannot change the database", async () => {
  const binary = await fakeServer("configured-opencode");
  const home = join(root, "explicit", "opencode");
  const db = join("custom-store", "sessions.db");
  const binding = opencode({
    home,
    binary: { path: join(root, "unusable-discovered-binary"), version: "opencode v2.3.2" },
    control: {
      binary: relative(process.cwd(), binary),
      env: { XDG_DATA_HOME: join(root, "other"), OPENCODE_DB: db },
      stopGraceMs: 300,
    },
  });
  const control = binding.control as OpenCodeSessionControl;
  try {
    const { session } = await control.start({ prompt, cwd: root, env: { OPENCODE_DB: db } });
    await expect(control.resume(session, { env: { OPENCODE_DISABLE_CHANNEL_DB: "1" } })).rejects.toThrow(/OPENCODE_DISABLE_CHANNEL_DB.*control\.env/);
    expect(await control.state(session)).toBe("idle");
    await control.close(session);
    storedSession(join(home, db), session.native);
    expect((await binding.reading?.coverage(session))?.status).toBe("empty");
    expect(await Bun.file(join(home, "custom-store", "sessions.json")).exists()).toBe(true);
    await expect(control.start({ prompt, env: { OPENCODE_DB: "different.db" } })).rejects.toThrow(/installation.*control\.env/);
    await expect(control.resume(session, { env: { OPENCODE_DB: ":memory:" } })).rejects.toThrow(/:memory:.*file-backed/);
  } finally {
    await control.dispose();
  }
});

test("binding takes XDG_DATA_HOME from the installation environment and falls back for empty values", () => {
  expect(opencode({ control: { env: { XDG_DATA_HOME: root } } }).instance.home).toBe(join(root, "opencode"));
  expect(opencode({ control: { env: { XDG_DATA_HOME: "" } } }).instance.home).toBe(resolve(homedir(), ".local", "share", "opencode"));
  expect(opencode({ control: { env: { XDG_DATA_HOME: "", HOME: root } } }).instance.home).toBe(join(root, ".local", "share", "opencode"));
  const before = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = root;
    expect(opencode().instance.home).toBe(join(root, "opencode"));
  } finally {
    if (before === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = before;
  }
});

test("binding refuses an invalid home or an in-memory database before spawning", () => {
  expect(() => opencode({ home: join(root, "wrong") })).toThrow(/must end in \/opencode/);
  expect(() => opencode({ control: { env: { OPENCODE_DB: ":memory:" } } })).toThrow(/:memory:.*file-backed/);
});

test("the database and sidecar paths stay inside the installation across symlinks", async () => {
  const home = join(root, "opencode");
  const outside = join(root, "outside");
  await mkdir(home);
  await mkdir(outside);
  await symlink(outside, join(home, "alias"));
  await symlink(join(outside, "missing-wal"), join(home, "sessions.db-wal"));

  expect(() => opencode({ home, control: { env: { OPENCODE_DB: join(home, "local", "sessions.db") } } })).not.toThrow();
  for (const db of [join(outside, "sessions.db"), "../outside/sessions.db", "alias/sessions.db", "sessions.db"]) {
    expect(() => opencode({ home, control: { env: { OPENCODE_DB: db } } })).toThrow(/SQLite sidecar files.*installation home/);
  }
});

test("history rechecks the database and SQLite sidecars after binding", async () => {
  const home = join(root, "opencode");
  const outside = join(root, "outside.db");
  await mkdir(home);
  storedSession(outside, "ses_outside");
  const reading = opencode({ home }).reading;
  if (reading === undefined) throw new Error("OpenCode history is missing");
  const outsideSession = sessionId(harnessId("opencode"), "ses_outside");
  const path = join(home, "opencode.db");
  await symlink(outside, path);
  expect(await reading.coverage(outsideSession)).toMatchObject({ status: "unavailable" });
  await rm(path);

  storedSession(path, "ses_inside");
  const inside = sessionId(harnessId("opencode"), "ses_inside");
  expect(await reading.coverage(inside)).toMatchObject({ status: "empty" });
  await symlink(outside, `${path}-wal`);
  expect(await reading.coverage(inside)).toMatchObject({ status: "unavailable" });
});

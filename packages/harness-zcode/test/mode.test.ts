// The mode ZCode restores a resumed session in: the last assistant message, then the project's
// `local_setting`, then the user's config file `permission.mode`, then the built-in `build`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { tempDirSync } from "@niwa-labs/testing";

import { configuredModeOf } from "../src/config.ts";
import { assistant, createDatabase, user, writeSession } from "../src/fixtures.ts";
import { configPathOf, dbPathOf } from "../src/paths.ts";
import { persistedModeOf } from "../src/reading.ts";

let home: string;
let work: string;
let db: Database;

beforeEach(() => {
  home = tempDirSync("zcode-mode");
  work = join(home, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(dbPathOf(home)), { recursive: true });
  db = createDatabase(dbPathOf(home));
  writeSession(db, "sess_plain", [user("m1", "hi"), assistant("m2", "hello")], { directory: work, project: "proj" });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const writeConfig = (content: unknown): void => {
  writeFileSync(configPathOf(home), typeof content === "string" ? content : JSON.stringify(content));
};
const setProjectMode = (mode: string): void => {
  db.query("insert into local_setting values ('project', 'proj', 'permission', 'mode', ?, 1, 1, 1)").run(JSON.stringify({ mode }));
};

test("with no config file the built-in mode is the answer", () => {
  expect(configuredModeOf(home)).toBeUndefined();
  expect(persistedModeOf(home, "sess_plain")).toBe("build");
});

test("the user's config file mode stands in for the built-in one", () => {
  writeConfig({ permission: { mode: "yolo", allowedTools: ["Read"] }, ui: { locale: "en" } });
  expect(configuredModeOf(home)).toBe("yolo");
  expect(persistedModeOf(home, "sess_plain")).toBe("yolo");
});

test("a config file that names no mode leaves the built-in one", () => {
  writeConfig({ permission: { allowedTools: ["Read"] } });
  expect(persistedModeOf(home, "sess_plain")).toBe("build");
  writeConfig({});
  expect(persistedModeOf(home, "sess_plain")).toBe("build");
});

test("the project's local setting wins over the config file", () => {
  writeConfig({ permission: { mode: "yolo" } });
  setProjectMode("plan");
  expect(persistedModeOf(home, "sess_plain")).toBe("plan");
});

test("a mode stamped on the last assistant message wins over both", () => {
  writeConfig({ permission: { mode: "yolo" } });
  setProjectMode("plan");
  const stamped = assistant("m4", "done");
  writeSession(db, "sess_stamped", [user("m3", "hi"), { ...stamped, data: { ...stamped.data, mode: "edit" } }], { directory: work, project: "proj" });
  expect(persistedModeOf(home, "sess_stamped")).toBe("edit");
});

test("a project's config files cannot set the mode: ZCode strips permission from them", () => {
  writeFileSync(join(work, "zcode.json"), JSON.stringify({ permission: { mode: "plan" } }));
  mkdirSync(join(work, ".zcode"));
  writeFileSync(join(work, ".zcode", "config.json"), JSON.stringify({ permission: { mode: "guarded" } }));
  expect(persistedModeOf(home, "sess_plain")).toBe("build");
  writeConfig({ permission: { mode: "auto" } });
  expect(persistedModeOf(home, "sess_plain")).toBe("auto");
});

test("a config file ZCode would not load is ignored: bad JSON, not an object, a mode it does not know", () => {
  for (const content of ["{ not json", "[]", '"yolo"', { permission: { mode: "reckless" } }, { permission: { mode: "" } }, { permission: "yolo" }]) {
    writeConfig(content);
    expect(configuredModeOf(home)).toBeUndefined();
    expect(persistedModeOf(home, "sess_plain")).toBe("build");
  }
});

test("every mode ZCode's schema accepts is read", () => {
  for (const mode of ["plan", "build", "edit", "yolo", "guarded", "auto"]) {
    writeConfig({ permission: { mode } });
    expect(configuredModeOf(home)).toBe(mode);
  }
});

test("a session the database does not know is unreadable whatever the config says", () => {
  writeConfig({ permission: { mode: "yolo" } });
  expect(persistedModeOf(home, "sess_nowhere")).toBeUndefined();
});

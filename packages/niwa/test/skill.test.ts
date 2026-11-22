// `niwa skill`: the text, the stamp, and where it is installed for each kind of harness. Every
// path is under a temp HOME; the real skills directories are never touched.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { installedText, skillText, runSkill } from "@niwa-labs/cli";

import { createMcpServer } from "@niwa-labs/mcp";

import { KINDS_WITH_SKILLS } from "../src/skills.ts";

let home = "";
let cwd = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "niwa-skill-home-"));
  cwd = mkdtempSync(join(tmpdir(), "niwa-skill-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const run = (...args: string[]) => runSkill(args, { home, cwd }, KINDS_WITH_SKILLS);
const claudeFile = () => join(home, ".claude", "skills", "niwa", "SKILL.md");
const sharedFile = () => join(home, ".agents", "skills", "niwa", "SKILL.md");

test("`niwa skill` prints the shipped text, and the text names real things", () => {
  const out = run();
  expect(out.code).toBe(0);
  expect(out.output).toBe(skillText().trimEnd());
  expect(out.output).toStartWith("---\nname: niwa\n");
  expect(out.output).toContain("session.start");
  expect(out.output).toContain('phase("Review")');
});

test("install writes the stamped file, one line per path, and the stamp is the last line", () => {
  const out = run("install", "--harness", "claude-code");
  expect(out).toEqual({ output: claudeFile(), code: 0 });
  const written = readFileSync(claudeFile(), "utf8");
  expect(written).toBe(installedText());
  expect(written.trimEnd().split("\n").at(-1)).toMatch(/^<!-- niwa skill \S+ [0-9a-f]{16} -->$/);
});

test("kinds that read the shared root give one file", () => {
  const out = run("install", "--harness", "codex,pi,zcode,mcode,ncode");
  expect(out).toEqual({ output: sharedFile(), code: 0 });
  expect(existsSync(claudeFile())).toBe(false);
});

test("`all` writes the two roots once each", () => {
  const out = run("install", "--harness", "all");
  expect(out.output.split("\n").sort()).toEqual([claudeFile(), sharedFile()].sort());
});

test("--project writes under the directory (cwd by default), not under the home", () => {
  const here = run("install", "--harness", "claude-code,pi", "--project");
  expect(here.output.split("\n").sort()).toEqual(
    [join(cwd, ".claude", "skills", "niwa", "SKILL.md"), join(cwd, ".agents", "skills", "niwa", "SKILL.md")].sort(),
  );
  const elsewhere = join(cwd, "other");
  const there = run("install", "--harness", "codex", "--project", elsewhere);
  expect(there.output).toBe(join(elsewhere, ".agents", "skills", "niwa", "SKILL.md"));
  expect(existsSync(sharedFile())).toBe(false);
});

test("--dry-run writes nothing", () => {
  const out = run("install", "--harness", "claude-code", "--dry-run");
  expect(out.output).toBe(`would write ${claudeFile()}`);
  expect(existsSync(claudeFile())).toBe(false);
});

test("an unchanged install is left alone, and an old stamped one is overwritten", () => {
  run("install", "--harness", "pi");
  expect(run("install", "--harness", "pi").output).toBe(`unchanged ${sharedFile()}`);

  // An older niwa's own text: stamped with the sha of what is above it, but not the shipped text.
  const old = "---\nname: niwa\n---\nold text\n";
  const sha = new Bun.CryptoHasher("sha256").update(old).digest("hex").slice(0, 16);
  writeFileSync(sharedFile(), `${old}<!-- niwa skill 0.0.1 ${sha} -->\n`);
  expect(run("status", "--harness", "pi").output).toBe(`stale ${sharedFile()} (pi)`);
  expect(run("install", "--harness", "pi")).toEqual({ output: sharedFile(), code: 0 });
  expect(readFileSync(sharedFile(), "utf8")).toBe(installedText());
});

test("a file edited by hand is kept without --force and overwritten with it", () => {
  run("install", "--harness", "claude-code");
  writeFileSync(claudeFile(), `${readFileSync(claudeFile(), "utf8").replace("# niwa", "# my niwa")}`);
  expect(run("status", "--harness", "claude-code").output).toBe(`modified ${claudeFile()} (claude-code)`);

  const refused = run("install", "--harness", "claude-code");
  expect(refused.code).toBe(1);
  expect(refused.output).toContain(`skipped ${claudeFile()}`);
  expect(readFileSync(claudeFile(), "utf8")).toContain("# my niwa");

  expect(run("install", "--harness", "claude-code", "--force")).toEqual({ output: claudeFile(), code: 0 });
  expect(readFileSync(claudeFile(), "utf8")).toBe(installedText());
});

test("a file with no stamp is not niwa's: it is modified", () => {
  mkdirSync(join(home, ".claude", "skills", "niwa"), { recursive: true });
  writeFileSync(claudeFile(), "mine\n");
  expect(run("status", "--harness", "claude-code").output).toStartWith("modified ");
  expect(run("install", "--harness", "claude-code").code).toBe(1);
  expect(readFileSync(claudeFile(), "utf8")).toBe("mine\n");
});

test("status reports each path once with the kinds that read it; absent when nothing is there", () => {
  expect(run("status").output.split("\n").sort()).toEqual(
    [`absent ${claudeFile()} (claude-code)`, `absent ${sharedFile()} (codex, mcode, ncode, opencode, pi, zcode)`].sort(),
  );
  run("install", "--harness", "all");
  expect(run("status").output).toContain(`current ${claudeFile()} (claude-code)`);
});

test("uninstall removes the file and its directory, and keeps an edited file without --force", () => {
  run("install", "--harness", "all");
  expect(run("uninstall", "--harness", "claude-code", "--dry-run").output).toBe(`would remove ${claudeFile()}`);
  expect(existsSync(claudeFile())).toBe(true);

  expect(run("uninstall", "--harness", "claude-code")).toEqual({ output: `removed ${claudeFile()}`, code: 0 });
  expect(existsSync(join(home, ".claude", "skills", "niwa"))).toBe(false);
  expect(run("uninstall", "--harness", "claude-code").output).toBe(`absent ${claudeFile()}`);

  writeFileSync(sharedFile(), "edited\n");
  const refused = run("uninstall", "--harness", "pi");
  expect(refused.code).toBe(1);
  expect(existsSync(sharedFile())).toBe(true);
  expect(run("uninstall", "--harness", "pi", "--force").output).toBe(`removed ${sharedFile()}`);
});

test("a kind with no skill root, or no kind at all, is refused by name", () => {
  const unknown = run("install", "--harness", "claude-sdk");
  expect(unknown.code).toBe(1);
  expect(unknown.output).toContain('"claude-sdk"');
  expect(unknown.output).toContain("claude-code");
  expect(run("install").output).toContain("--harness");
  expect(run("bogus").code).toBe(1);
  expect(run("install", "--harness", "pi", "--wat").code).toBe(1);
  expect(existsSync(sharedFile())).toBe(false);
});

test("the program works with no host and a temp HOME", async () => {
  const entry = join(import.meta.dir, "..", "bin", "niwa.ts");
  const env = { ...process.env, HOME: home, NIWA_HOME: join(home, "no-host") };
  const printed = Bun.spawnSync(["bun", entry, "skill"], { env, cwd });
  expect(printed.exitCode).toBe(0);
  expect(printed.stdout.toString().trimEnd()).toBe(skillText().trimEnd());
  const installed = Bun.spawnSync(["bun", entry, "skill", "install", "--harness", "claude-code"], { env, cwd });
  expect(installed.exitCode).toBe(0);
  expect(installed.stdout.toString().trim()).toBe(claudeFile());
});

test("the MCP server tells an agent where the skill is", async () => {
  const mcp = createMcpServer({ home });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  const instructions = client.getInstructions() ?? "";
  expect(instructions).toContain("niwa skill`");
  expect(instructions).toContain("niwa skill install --harness <your harness kind>");
  await client.close();
  await mcp.close();
});

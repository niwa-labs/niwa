/**
 * Stage a self-contained Niwa workspace, then switch the installed command to it.
 * Run from a checkout with Bun: bun scripts/install-client.ts stage [store]
 * Activate a staged release: bun scripts/install-client.ts activate <release> [bin]
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const entry = "packages/niwa/bin/niwa.ts";
const bun = Bun.which("bun") ?? process.execPath;

function command(args: string[], options: { cwd: string; stdin?: Uint8Array; clean?: boolean; timeout?: number }): string {
  const child = Bun.spawnSync(args, {
    cwd: options.cwd,
    env: options.clean ? { PATH: process.env.PATH } : process.env,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout,
  });
  if (!child.success) throw new Error(args.slice(0, 2).join(" ") + " failed:\n" + child.stderr.toString() + child.stdout.toString());
  return child.stdout.toString();
}

function copySources(release: string): void {
  // Preserve workspace layout and runtime assets, including new files in the working checkout.
  const files = command(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    "--", "package.json", "bun.lock", "bunfig.toml", "packages"], { cwd: root });
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    const source = join(root, file);
    const state = lstatSync(source, { throwIfNoEntry: false });
    if (state === undefined) continue; // tracked deletion in the working checkout
    if (!state.isFile() || source !== realpathSync(source)) throw new Error("Expected a regular source file: " + file);
    const target = join(release, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, state.mode & 0o777);
  }
}

function outsideCheckout(release: string): void {
  const location = relative(root, release);
  if (location !== ".." && !location.startsWith(".." + sep) && !isAbsolute(location)) {
    throw new Error("The release must be outside the development checkout");
  }
}

function validate(release: string): void {
  outsideCheckout(release);
  function checkLinks(folder: string): void {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isDirectory()) checkLinks(path);
      if (!item.isSymbolicLink()) continue;
      const target = relative(release, realpathSync(path));
      if (isAbsolute(readlinkSync(path)) || target === ".." || target.startsWith(".." + sep) || isAbsolute(target)) {
        throw new Error("Dependency points outside the release: " + path);
      }
    }
  }
  checkLinks(release);

  const cli = join(release, entry);
  const skill = command([bun, cli, "skill"], { cwd: release, clean: true, timeout: 15_000 });
  if (!skill.startsWith("---\n") || !skill.includes("name: niwa")) throw new Error("Unexpected output from niwa skill");

  const probe = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "niwa-install", version: "1" } },
  };
  const output = command([bun, cli, "--home", join(release, ".install-probe"), "mcp"], {
    cwd: release, clean: true, timeout: 15_000, stdin: new TextEncoder().encode(JSON.stringify(probe) + "\n"),
  });
  const response = JSON.parse(output.trim()) as { id?: number; result?: { serverInfo?: { name?: string } } };
  if (response.id !== 1 || response.result?.serverInfo?.name !== "niwa") throw new Error("Niwa MCP initialization failed");
}

function stage(store: string): string {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const directory = realpathSync(store);
  outsideCheckout(directory);
  const release = mkdtempSync(join(directory, "release-"));
  try {
    copySources(release);
    command([bun, "install", "--frozen-lockfile", "--production", "--backend=copyfile"], { cwd: release });
    validate(release);
    return release;
  } catch (error) {
    rmSync(release, { recursive: true, force: true });
    throw error;
  }
}

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

function activate(release: string, bin: string): string {
  validate(release);
  mkdirSync(bin, { recursive: true });
  const name = join(bin, "niwa");
  // Stage the executable on the same filesystem. A failed update leaves the old command usable.
  const temporary = mkdtempSync(join(bin, ".niwa-update-"));
  const launcher = join(temporary, "niwa");
  try {
    writeFileSync(launcher, [
      "#!/bin/sh",
      "export NIWA_CLIENT_BIN=" + quote(name),
      "exec " + quote(bun) + " " + quote(join(release, entry)) + ' "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
    renameSync(launcher, name);
    return name;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const [operation, ...args] = process.argv.slice(2);
try {
  if (operation === "stage" && args.length <= 1) {
    console.log(stage(resolve(args[0] ?? join(homedir(), ".local", "share", "niwa-client"))));
  } else if (operation === "activate" && args[0] && args.length <= 2) {
    console.log(activate(realpathSync(args[0]), resolve(args[1] ?? join(homedir(), ".local", "bin"))));
  } else {
    throw new Error("Usage: install-client.ts stage [store] | activate <release> [bin]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

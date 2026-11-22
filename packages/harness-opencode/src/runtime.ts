import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("./pipe-worker.ts", import.meta.url));
const BUILD = fileURLToPath(new URL("../scripts/build-runtime.ts", import.meta.url));
export const OPENCODE_BUILD_DIRECTORY = dirname(SOURCE);
export const PACKED_RUNTIME = fileURLToPath(new URL("../dist/opencode-runtime", import.meta.url));
const ENTRY = "pipe-worker.js";
const BUN_FLAGS = ["--config=/dev/null", "--no-env-file", "--no-install"];

/** Bundles the official server, including its dynamic JS and WASM chunks. Only bundler code runs here. */
export function buildOpenCodeWorker(output: string, metafile?: string): void {
  const build = Bun.spawnSync({
    cmd: [
      process.execPath, ...BUN_FLAGS, BUILD, SOURCE, output, ...(metafile === undefined ? [] : [metafile]),
    ],
    cwd: OPENCODE_BUILD_DIRECTORY,
    env: { HOME: output, TMPDIR: output, PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`Could not build the boxed OpenCode runtime: ${build.stderr.toString().trim()}`);
}

/** The vendor bundle resolves its native PTY package by name at runtime. Copy just this platform's package. */
function copyNativePty(output: string): void {
  const manifest = Bun.resolveSync("@opencode/pty/package.json", dirname(SOURCE));
  const report = process.platform === "linux" ? process.report.getReport() as { header: { glibcVersionRuntime?: string } } : undefined;
  const libc = report === undefined ? undefined : report.header.glibcVersionRuntime ? "gnu" : "musl";
  const name = ["pty", process.platform, process.arch, libc].filter(Boolean).join("-");
  const platformManifest = Bun.resolveSync(`@opencode/${name}/package.json`, dirname(manifest));
  const binary = process.platform === "win32" ? "opencode-pty.exe" : "opencode-pty";
  const target = join(output, "node_modules", "@opencode", name);
  mkdirSync(join(target, "bin"), { recursive: true });
  copyFileSync(platformManifest, join(target, "package.json"));
  copyFileSync(join(dirname(platformManifest), "bin", binary), join(target, "bin", binary));
  chmodSync(join(target, "bin", binary), 0o755);
}

interface WorkerRuntime {
  readonly root: string;
  readonly args: readonly string[];
}

let staged: WorkerRuntime | undefined;

/** Publish one host-local runtime. Each session grants this tree read access through its box profile. */
export function opencodeWorker(): WorkerRuntime {
  if (staged !== undefined) return staged;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "niwa-opencode-runtime-")));
  const clean = () => rmSync(root, { recursive: true, force: true });
  try {
    if (existsSync(join(PACKED_RUNTIME, ENTRY))) {
      cpSync(PACKED_RUNTIME, root, {
        recursive: true,
        filter(source) {
          if (lstatSync(source).isSymbolicLink()) throw new Error(`Unexpected symbolic link in packed OpenCode runtime: ${source}`);
          return true;
        },
      });
    }
    else buildOpenCodeWorker(root);
    copyNativePty(root);
    process.once("exit", clean);
    staged = { root, args: [...BUN_FLAGS, join(root, ENTRY)] };
    return staged;
  } catch (error) {
    clean();
    throw error;
  }
}

/**
 * The cockpit app as the web surface serves it. This entry runs on the host's machine and imports no React: it finds the built
 * app, builds it when it is missing or older than its sources, and says which modules the client modules of the plugins share.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { entryName, SHARED_MODULES } from "./shared-modules.ts";

export { SHARED_MODULES } from "./shared-modules.ts";

/** The cockpit app, as the web surface takes it: where it was built, and the modules its client modules share. */
export type CockpitApp = {
  readonly root: string;
  readonly imports: Readonly<Record<string, string>>;
};

/** The folder of this package. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where the build puts the app. */
export const DIST = join(PACKAGE_ROOT, "dist");

type ManifestEntry = { file: string; name?: string; isEntry?: boolean };

function manifestOf(root: string): Record<string, ManifestEntry> | undefined {
  const file = join(root, ".vite", "manifest.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, ManifestEntry>) : undefined;
}

/** The import map of a built app: each shared module by the address of the entry that serves it. */
export function importsOf(root: string): Record<string, string> | undefined {
  const manifest = manifestOf(root);
  if (manifest === undefined) return undefined;
  const entries = Object.values(manifest).filter((entry) => entry.isEntry === true);
  const imports: Record<string, string> = {};
  for (const shared of SHARED_MODULES) {
    const entry = entries.find((one) => one.name === entryName(shared.name));
    if (entry === undefined) return undefined;
    imports[shared.name] = `/${entry.file}`;
  }
  return imports;
}

function newest(path: string): number {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return readdirSync(path).reduce((latest, name) => Math.max(latest, newest(join(path, name))), info.mtimeMs);
}

/**
 * What the app is built from: its own sources, and the SDK and the kit, which the build carries as shared modules, so a change
 * in either is a change of the app.
 */
export const BUILD_SOURCES: readonly string[] = [
  join(PACKAGE_ROOT, "src"),
  join(PACKAGE_ROOT, "index.html"),
  join(PACKAGE_ROOT, "vite.config.ts"),
  join(PACKAGE_ROOT, "..", "cockpit-sdk", "src"),
  join(PACKAGE_ROOT, "..", "ui-kit", "src"),
];

/** Whether the app was built before one of its sources changed. */
export function isStale(root: string = DIST, sources: readonly string[] = BUILD_SOURCES): boolean {
  const built = join(root, ".vite", "manifest.json");
  if (!existsSync(built)) return true;
  const at = statSync(built).mtimeMs;
  return sources.some((source) => existsSync(source) && newest(source) > at);
}

/** Build the app into `dist`, or into another folder. */
export async function buildCockpit(options: { outDir?: string } = {}): Promise<void> {
  const { build } = await import("vite");
  await build({
    configFile: join(PACKAGE_ROOT, "vite.config.ts"),
    root: PACKAGE_ROOT,
    logLevel: "warn",
    ...(options.outDir === undefined ? {} : { build: { outDir: options.outDir, emptyOutDir: true } }),
  });
}

/**
 * The app, built. A missing or stale build is made first, so `niwa web` serves what the sources say.
 *
 * @throws when the build cannot be made, or the app it made does not name every shared module.
 */
export async function cockpitApp(options: { root?: string; rebuild?: boolean } = {}): Promise<CockpitApp> {
  const root = options.root ?? DIST;
  if (options.root === undefined && (options.rebuild === true || isStale(root))) await buildCockpit();
  const imports = importsOf(root);
  if (imports === undefined) throw new Error(`the cockpit app at ${root} was not built: run "bun run build" in the cockpit package`);
  return { root, imports };
}

/**
 * The cockpit app as the web surface serves it. This entry runs on the host's machine and imports no React: it finds the built
 * app, builds it when the checkout has no build of its sources, and says which modules the client modules of the plugins share.
 *
 * Where the app comes from:
 *
 * - an installed package carries the app built when it was packed, in `dist/app`, and serves it as it is;
 * - a checkout builds the app from its sources into a folder of its own for every state of those sources, `dist/builds/<id>`,
 *   and never touches a folder after it is complete, so a server that started with one keeps its files when the sources
 *   change and the next server builds another.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/** Where the builds are. */
export const DIST = join(PACKAGE_ROOT, "dist");

/** The app as the package ships it: made when the package is packed, and the only build an installed package has. */
export const ARTIFACT = join(DIST, "app");

/** The builds of a checkout, one folder for each state of the sources. */
export const BUILDS = join(DIST, "builds");

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

/** The folders a `@source "<pattern>"` of the stylesheet names, one `*` segment standing for any folder. */
function scannedBy(stylesheet: string): string[] {
  // An installed package has no stylesheet and builds nothing.
  if (!existsSync(stylesheet)) return [];
  const base = dirname(stylesheet);
  const found: string[] = [];
  for (const [, pattern] of readFileSync(stylesheet, "utf8").matchAll(/@source\s+"([^"]+)"/g)) {
    let folders = [base];
    // The fingerprint walks directories itself, while Tailwind needs an explicit recursive file glob.
    const directory = pattern!.split("/**/")[0]!;
    for (const segment of directory.split("/")) {
      folders = folders.flatMap((folder) => {
        if (segment !== "*") return [resolve(folder, segment)];
        return existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name)) : [];
      });
    }
    found.push(...folders);
  }
  return found.filter((folder) => existsSync(folder));
}

/**
 * What the app is built from: its own sources, the SDK and the kit, which the build carries as shared modules, and the
 * folders its stylesheet scans for the classes of the plugins' pages, so a change in any of them is a change of the app.
 */
export const BUILD_SOURCES: readonly string[] = [
  join(PACKAGE_ROOT, "src"),
  join(PACKAGE_ROOT, "index.html"),
  join(PACKAGE_ROOT, "vite.config.ts"),
  join(PACKAGE_ROOT, "scripts", "third-party-notices.ts"),
  join(PACKAGE_ROOT, "scripts", "highlight-catalog.ts"),
  join(PACKAGE_ROOT, "notices"),
  join(PACKAGE_ROOT, "package.json"),
  join(PACKAGE_ROOT, "..", "ui-kit", "src"),
  ...scannedBy(join(PACKAGE_ROOT, "src", "styles.css")),
];

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => filesUnder(join(path, name)));
}

/** A name for the state of the sources: the same content, wherever it is and whenever it was written, is the same name. */
export function fingerprint(sources: readonly string[] = BUILD_SOURCES): string {
  const hash = createHash("sha256");
  for (const source of sources) {
    if (!existsSync(source)) continue;
    for (const file of filesUnder(source)) {
      hash.update(`${relative(PACKAGE_ROOT, file)}\0`);
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 20);
}

/** How the app is made into a folder. */
export type Builder = (outDir: string) => Promise<void>;

const viteBuild: Builder = async (outDir) => {
  const { build } = await import("vite");
  await build({
    configFile: join(PACKAGE_ROOT, "vite.config.ts"),
    root: PACKAGE_ROOT,
    logLevel: "warn",
    build: { outDir, emptyOutDir: true },
  });
};

/**
 * Build the app into `outDir` as it is, replacing what is there.
 *
 * Without `outDir` the app is built into a folder of its own among the checkout's builds, named for the state of the
 * sources: it is made aside and moved into place once it is complete and names every shared module, so no server ever sees
 * half of a build, and a build that is there already is not made again unless `fresh` asks.
 *
 * @returns the folder of the build.
 */
export async function buildCockpit(options: { outDir?: string; builds?: string; sources?: readonly string[]; fresh?: boolean; builder?: Builder } = {}): Promise<string> {
  const builder = options.builder ?? viteBuild;
  if (options.outDir !== undefined) {
    await builder(options.outDir);
    return options.outDir;
  }
  const builds = options.builds ?? BUILDS;
  const id = fingerprint(options.sources);
  const target = join(builds, options.fresh === true ? `${id}-${Date.now().toString(36)}` : id);
  if (existsSync(target) && importsOf(target) !== undefined) return target;
  mkdirSync(builds, { recursive: true });
  const aside = join(builds, `.making-${basename(target)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await builder(aside);
    if (importsOf(aside) === undefined) throw new Error(`the cockpit app was built without every shared module: see ${aside}`);
    try {
      renameSync(aside, target);
    } catch (error) {
      // Another build of the same sources got there first, and a server may already read it: keep it.
      if (!(existsSync(target) && importsOf(target) !== undefined)) throw error;
    }
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
  return target;
}

/** Whether this is a checkout, which has the sources to build from, and not an installed package, which has the app only. */
export function inCheckout(root: string = PACKAGE_ROOT): boolean {
  return existsSync(join(root, "vite.config.ts"));
}

/**
 * The app, built. A checkout makes the build of its sources when there is none; an installed package serves the app it was
 * packed with.
 *
 * @throws when the app cannot be built or found, or the one found does not name every shared module.
 */
export async function cockpitApp(
  options: { root?: string; rebuild?: boolean; packageRoot?: string; builds?: string; sources?: readonly string[]; builder?: Builder } = {},
): Promise<CockpitApp> {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  let root = options.root;
  if (root === undefined) {
    if (inCheckout(packageRoot)) {
      root = await buildCockpit({
        fresh: options.rebuild === true,
        ...(options.builds === undefined ? {} : { builds: options.builds }),
        ...(options.sources === undefined ? {} : { sources: options.sources }),
        ...(options.builder === undefined ? {} : { builder: options.builder }),
      });
    } else {
      root = join(packageRoot, "dist", "app");
    }
  }
  const imports = importsOf(root);
  if (imports === undefined) throw new Error(`the cockpit app at ${root} was not built: run "bun run build" in the cockpit package`);
  return { root, imports };
}

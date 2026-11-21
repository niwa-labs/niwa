/**
 * The cockpit app as the web surface serves it: the built files of the app, and the client modules of the plugins.
 *
 * The surface knows no page of its own. It is given the folder of a built app and the import map the app's modules share,
 * and serves the folder's files, the app's `index.html` for every address of the app, and each plugin module built for the
 * browser from the source the host lists, under the hash the host lists.
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import { CATALOG_ACTION, CatalogOutput } from "@niwa-labs/client";
import type { CatalogAnswer, NiwaApi } from "@niwa-labs/client";

/** The cockpit app: where it was built, and what a client module imports from it instead of carrying its own copy. */
export interface WebApp {
  /** The folder of the built app: its `index.html` and the files that page names. */
  readonly root: string;
  /**
   * The shared modules, by the name a client module imports them by, each with the address the app serves it at. They go
   * into the import map of the page, and a client module is built with these names left as imports.
   */
  readonly imports: Readonly<Record<string, string>>;
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** The content type of a file by its extension; plain bytes when the extension is not one the app has. */
export function typeOf(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Where the files of the app are asked for. */
export const ASSETS_PREFIX = "/assets/";

/** Where the client modules are asked for: `/modules/<id>/<hash>/index.js`. */
export const MODULES_PREFIX = "/modules/";

/**
 * The file of the app a path names, or undefined when it names none: only regular files inside the folder, whichever links
 * lie on the way. The folder and the file are both resolved to where they really are before the one is held to the other,
 * and the path that comes back is the resolved one, so what is read is what was checked.
 */
export async function assetFile(app: WebApp, path: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  try {
    const root = await realpath(app.root);
    const file = await realpath(join(root, decoded));
    const within = relative(root, file);
    if (within === "" || isAbsolute(within) || within.split(sep)[0] === "..") return undefined;
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The import map of the page: the shared modules by name. */
export function importMapOf(app: WebApp): string {
  return JSON.stringify({ imports: app.imports });
}

/** The hash a content security policy names an inline script by. */
export function scriptHash(content: string): string {
  return `'sha256-${createHash("sha256").update(content).digest("base64")}'`;
}

/**
 * The page of the app with the import map in it, and the hash of the map's script: the policy lets the page's own scripts
 * and this one run, and no other inline script.
 */
export async function pageOf(app: WebApp): Promise<{ html: string; hash: string }> {
  const template = await readFile(join(app.root, "index.html"), "utf8");
  const map = importMapOf(app);
  const tag = `<script type="importmap">${map}</script>`;
  // The map comes first: a module script that is already fetched when the map is read would not see it.
  const html = /<head[^>]*>/i.test(template) ? template.replace(/<head[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${template}`;
  return { html, hash: scriptHash(map) };
}

/** A module of the catalogue as the browser is told of it. */
export interface ServedModule {
  readonly id: string;
  readonly package: string;
  readonly version: string;
  readonly entry: string;
  /** The hash of the bytes the browser gets at `entry`; the hash the host lists when the module cannot be built. */
  readonly hash: string;
  readonly styles?: readonly string[];
}

/** The address of a module's code. The hash is a path segment, so the module's relative imports carry it too. */
export function moduleAddress(id: string, hash: string): string {
  return `${MODULES_PREFIX}${id}/${hash}/index.js`;
}

/** The address of a stylesheet of a module; its own hash makes a changed sheet a new address. */
export function styleAddress(id: string, moduleHash: string, index: number, sheetHash: string): string {
  return `${MODULES_PREFIX}${id}/${moduleHash}/style-${String(index)}-${sheetHash.slice(0, 12)}.css`;
}

/**
 * What the host lists, as the browser is told of it when there is no app to build modules for: the addresses are the host's
 * hashes of the sources, and nothing is served there.
 */
export async function catalogueOf(api: NiwaApi): Promise<{ modules: ServedModule[] }> {
  const listed = CatalogOutput.parse(await api.call(CATALOG_ACTION, {}));
  return {
    modules: listed.modules.map((module) => ({
      id: module.id,
      package: module.plugin,
      version: module.version,
      entry: moduleAddress(module.id, module.hash),
      hash: module.hash,
      ...(module.styles.length === 0
        ? {}
        : { styles: module.styles.map((sheet, index) => styleAddress(module.id, module.hash, index, sheet.hash)) }),
    })),
  };
}

/** What the surface holds of a module the host lists: the bytes it serves, or why there are none. */
interface HeldModule {
  readonly served: ServedModule;
  /** The code and the sheets as they are served, each under the hash of those bytes. */
  readonly built?: { readonly code: string; readonly hash: string; readonly sheets: readonly Sheet[] };
  /** Why the module could not be built; its address is then the host's hash of the source. */
  readonly problem?: string;
}

interface Sheet {
  readonly text: string;
  readonly hash: string;
}

/** A file of a module as the browser asks for it: the code, or one of the sheets by position and hash prefix. */
export type ModuleFile = { readonly sheet?: undefined } | { readonly sheet: { readonly index: number; readonly hash: string } };

/** What a request for a module's file is answered with. */
export type ModuleAnswer = { readonly code: string } | { readonly css: string } | { readonly problem: string };

/**
 * The client modules built for the browser. The address of a module and of each of its sheets is the hash of the bytes served
 * there, never the hash of the source the host lists: the same source builds to other bytes when the modules the page shares
 * change, and a browser that kept the old bytes under a name that did not change would run stale code. The bytes that were
 * hashed are the bytes that are served; nothing is read again once the address is made.
 */
export class ModuleBuilds {
  /** Builds by the id and source hash the host lists, so one source is built once. */
  readonly #builds = new Map<string, Promise<Built>>();
  /** Sheets by the file and hash the host lists. */
  readonly #sheets = new Map<string, Promise<Sheet>>();

  /** The modules the host lists now, each as the browser is told of it. */
  async catalogue(api: NiwaApi, app: WebApp): Promise<ServedModule[]> {
    return (await this.#hold(api, app)).map((held) => held.served);
  }

  /**
   * The file a module is served at under this id and hash, when the host lists such a module now and the hash is the one of
   * its bytes (of its source, when it cannot be built). Undefined when nothing is served there, so nothing else is read.
   */
  async file(api: NiwaApi, app: WebApp, id: string, hash: string, file: ModuleFile): Promise<ModuleAnswer | undefined> {
    const held = (await this.#hold(api, app)).find((module) => module.served.id === id && module.served.hash === hash);
    if (held === undefined) return undefined;
    if (held.built === undefined) return { problem: held.problem ?? "the module could not be built" };
    if (file.sheet === undefined) return { code: held.built.code };
    const sheet = held.built.sheets[file.sheet.index];
    return sheet === undefined || !sheet.hash.startsWith(file.sheet.hash) ? undefined : { css: sheet.text };
  }

  async #hold(api: NiwaApi, app: WebApp): Promise<HeldModule[]> {
    const listed = CatalogOutput.parse(await api.call(CATALOG_ACTION, {})).modules;
    const held = await Promise.all(listed.map((module) => this.#holdOne(module, app)));
    // What the host no longer lists is forgotten, so a changed module leaves nothing behind.
    const builds = new Set(listed.map((module) => `${module.id}/${module.hash}`));
    const sheets = new Set(listed.flatMap((module) => module.styles.map((sheet) => `${sheet.file}/${sheet.hash}`)));
    for (const key of [...this.#builds.keys()]) if (!builds.has(key)) this.#builds.delete(key);
    for (const key of [...this.#sheets.keys()]) if (!sheets.has(key)) this.#sheets.delete(key);
    return held;
  }

  async #holdOne(module: CatalogAnswer["modules"][number], app: WebApp): Promise<HeldModule> {
    const key = `${module.id}/${module.hash}`;
    let build = this.#builds.get(key);
    if (build === undefined) {
      build = buildModule(module.entry, Object.keys(app.imports));
      this.#builds.set(key, build);
      // A failed build is tried again at the next request: a transient failure is not remembered.
      void build.then((result) => {
        if ("problem" in result) this.#builds.delete(key);
      });
    }
    const built = await build;
    const unbuilt = (problem: string): HeldModule => ({
      served: { id: module.id, package: module.plugin, version: module.version, entry: moduleAddress(module.id, module.hash), hash: module.hash },
      problem,
    });
    if ("problem" in built) return unbuilt(built.problem);
    let sheets: Sheet[];
    try {
      sheets = await Promise.all(module.styles.map((sheet) => this.#sheet(sheet)));
    } catch (error) {
      return unbuilt(`a stylesheet could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      served: {
        id: module.id,
        package: module.plugin,
        version: module.version,
        entry: moduleAddress(module.id, built.hash),
        hash: built.hash,
        ...(sheets.length === 0 ? {} : { styles: sheets.map((sheet, index) => styleAddress(module.id, built.hash, index, sheet.hash)) }),
      },
      built: { code: built.code, hash: built.hash, sheets },
    };
  }

  #sheet(listed: { readonly file: string; readonly hash: string }): Promise<Sheet> {
    const key = `${listed.file}/${listed.hash}`;
    let sheet = this.#sheets.get(key);
    if (sheet === undefined) {
      sheet = readFile(listed.file, "utf8").then((text) => ({ text, hash: createHash("sha256").update(text).digest("hex") }));
      this.#sheets.set(key, sheet);
      sheet.catch(() => this.#sheets.delete(key));
    }
    return sheet;
  }
}

type Built = { code: string; hash: string } | { problem: string };

/** The package a specifier names: `react/jsx-runtime` is of `react`, `@niwa-labs/ui-kit/x` of `@niwa-labs/ui-kit`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Leave exactly the shared specifiers as imports. The page's import map names these and no others, so a specifier of a shared
 * package that the map lacks would build and then fail in the browser; it is refused at the build instead. Bundling it would
 * give the module a second copy of a package the page already has one of.
 */
function sharedImports(shared: readonly string[]): Bun.BunPlugin {
  const names = new Set(shared);
  const packages = new Set(shared.map(packageOf));
  return {
    name: "niwa-shared-imports",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (names.has(args.path)) return { path: args.path, external: true };
        if (packages.has(packageOf(args.path))) {
          throw new Error(`${args.path} is not shared by the cockpit: a module imports ${shared.filter((name) => packageOf(name) === packageOf(args.path)).join(", ")} of that package`);
        }
        return undefined;
      });
    },
  };
}

/** Build one module for the browser. The shared modules stay imports, and the page's import map resolves them. */
async function buildModule(entry: string, shared: readonly string[]): Promise<Built> {
  const result = await Bun.build({
    throw: false,
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    plugins: [sharedImports(shared)],
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    jsx: { runtime: "automatic", importSource: "react", development: false },
  });
  if (!result.success) return { problem: result.logs.map((log) => log.message).join("\n") };
  const output = result.outputs.find((file) => file.kind === "entry-point") ?? result.outputs[0];
  if (output === undefined) return { problem: "the build made no file" };
  const code = await output.text();
  return { code, hash: createHash("sha256").update(code).digest("hex") };
}

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
import type { NiwaApi } from "@niwa-labs/client";

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

/** What the host lists, as the browser is told of it. */
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

type Built = { code: string; hash: string } | { problem: string };

/** The client modules built for the browser, by id and hash: the host's hash is the address, so a build is made once. */
export class ModuleBuilds {
  readonly #built = new Map<string, Promise<Built>>();

  /**
   * The code of a module the host lists now under this id and hash, built for the browser with the app's shared modules left
   * as imports. Undefined when the host lists no such module, so nothing else is ever built or read.
   */
  async code(api: NiwaApi, app: WebApp, id: string, hash: string): Promise<string | { problem: string } | undefined> {
    const listed = CatalogOutput.parse(await api.call(CATALOG_ACTION, {})).modules.find((module) => module.id === id && module.hash === hash);
    if (listed === undefined) return undefined;
    const key = `${id}/${hash}`;
    let build = this.#built.get(key);
    if (build === undefined) {
      build = buildModule(listed.entry, Object.keys(app.imports));
      this.#built.set(key, build);
      // A failed build is tried again at the next request: the source may have been repaired under the same hash only by
      // a change the hash covers, so a repeat of the same failure is cheap and a transient one is not remembered.
      void build.then((result) => {
        if ("problem" in result) this.#built.delete(key);
      });
    }
    const result = await build;
    return "problem" in result ? result : result.code;
  }

  /** The stylesheet of a module the host lists now under this id and hash and the sheet's own hash prefix. */
  async style(api: NiwaApi, id: string, hash: string, index: number, sheetHash: string): Promise<string | undefined> {
    const listed = CatalogOutput.parse(await api.call(CATALOG_ACTION, {})).modules.find((module) => module.id === id && module.hash === hash);
    const sheet = listed?.styles[index];
    if (sheet === undefined || !sheet.hash.startsWith(sheetHash)) return undefined;
    return readFile(sheet.file, "utf8");
  }
}

/** Build one module for the browser. The shared modules stay imports, and the page's import map resolves them. */
async function buildModule(entry: string, shared: readonly string[]): Promise<Built> {
  const result = await Bun.build({
    throw: false,
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: [...shared],
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

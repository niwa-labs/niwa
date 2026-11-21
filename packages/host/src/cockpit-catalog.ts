/**
 * The catalogue of cockpit modules: what the plugins offer (`COCKPIT_MODULE`), listed with the hash of each
 * module's code.
 *
 * A module is not imported here. It is a source file inside its plugin's tree, and the web server builds it for the
 * browser. Its hash covers the entry and every local file it imports, so a changed file is a new address and no cache
 * serves old code.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { CockpitModuleOffer, Offered } from "@niwa-labs/plugin";
import type { CatalogAnswer } from "@niwa-labs/client";

const LOADERS = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".mts": "ts" } as const;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"];
const ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The file a relative import names, with the extensions and the index file a bundler would try; undefined when none. */
function resolveLocal(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, ...EXTENSIONS.map((ext) => `${base}${ext}`), ...EXTENSIONS.map((ext) => join(base, `index${ext}`))];
  return candidates.find(isFile);
}

/** The local files a source imports: the relative specifiers only, those that name a file. */
function localImports(file: string, source: string): string[] {
  const loader = LOADERS[extname(file) as keyof typeof LOADERS];
  if (loader === undefined) return [];
  const found = new Bun.Transpiler({ loader }).scanImports(source);
  return found
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."))
    .flatMap((path) => resolveLocal(file, path) ?? []);
}

/** The sha256 of a file and of every local file it imports, each by its path relative to the entry. */
export function closureHash(entry: string): string {
  const files = new Map<string, Uint8Array>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    const bytes = readFileSync(file);
    files.set(file, bytes);
    queue.push(...localImports(file, bytes.toString("utf8")));
  }
  const hash = createHash("sha256");
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${relative(dirname(entry), file)}\0`).update(bytes).update("\0");
  }
  return hash.digest("hex");
}

function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Why an offer cannot be listed, undefined when it can. */
function problemWith(offer: CockpitModuleOffer): string | undefined {
  if (!ID.test(offer.id)) return `the id "${offer.id}" is not lowercase words joined by - or .`;
  for (const file of [offer.entry, ...(offer.styles ?? [])]) {
    if (!isAbsolute(file)) return `${file} is not an absolute path`;
    if (!isFile(file)) return `${file} is not a file`;
  }
  return undefined;
}

/**
 * The modules the plugins offer, in the order the plugins were installed. An offer that is not a module (a bad id, a
 * file that is not there) is an error of the plugin that made it, said when the catalogue is read.
 */
export function catalogOf(offers: readonly Offered<CockpitModuleOffer>[], versionOf: (plugin: string) => string): CatalogAnswer {
  return {
    modules: offers.map(({ plugin, value }) => {
      const problem = problemWith(value);
      if (problem !== undefined) throw new TypeError(`plugin "${plugin}" offers the cockpit module "${value.id}": ${problem}`);
      return {
        id: value.id,
        plugin,
        version: versionOf(plugin),
        entry: value.entry,
        hash: closureHash(value.entry),
        styles: (value.styles ?? []).map((file) => ({ file, hash: fileHash(file) })),
      };
    }),
  };
}

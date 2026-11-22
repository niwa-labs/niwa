import { cpSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type { BunPlugin } from "bun";

const [, , source, output, metafile] = process.argv;
if (source === undefined || output === undefined) throw new Error("The OpenCode build needs its source and output paths");

// Bun inlines the source path for CJS __dirname and __filename. Change only the expressions
// that need relocation, before Bun hashes the chunks. Importing ESM syntax in the CJS files
// directly would change how the bundler translates module.exports.
const directory = "require('niwa:runtime-path').directory";
const filename = "require('niwa:runtime-path').filename";
const adaptations = [
  {
    filter: /[/\\]@silvia-odwyer[/\\]photon-node[/\\]photon_rs\.js$/,
    from: "require('path').join(__dirname, 'photon_rs_bg.wasm')",
    to: `require('path').join(${directory}, 'photon_rs_bg.wasm')`,
  },
  {
    filter: /[/\\]@npmcli[/\\]arborist[/\\]lib[/\\]debug\.js$/,
    from: "require('node:path').resolve(__dirname, '..')",
    to: directory,
  },
  {
    filter: /[/\\]write-file-atomic[/\\]lib[/\\]index\.js$/,
    from: ".update(__filename)",
    to: `.update(${filename})`,
  },
  {
    filter: /[/\\]@npmcli[/\\]run-script[/\\]lib[/\\]set-path\.js$/,
    from: "resolve(__dirname, '../lib/node-gyp-bin')",
    to: `resolve(${directory}, 'assets', 'node-gyp-bin')`,
    asset: "node-gyp-bin",
  },
] as const;

const assets = new Map<string, string>();
const relocations: BunPlugin = {
  name: "relocate-opencode-runtime",
  setup(build) {
    build.onResolve({ filter: /^niwa:runtime-path$/ }, () => ({ path: "paths", namespace: "niwa-runtime" }));
    build.onLoad({ namespace: "niwa-runtime", filter: /^paths$/ }, () => ({
      contents: "export const directory = import.meta.dir; export const filename = import.meta.path;",
      loader: "js",
    }));
    for (const item of adaptations) {
      build.onLoad({ filter: item.filter }, async ({ path }) => {
        const contents = await Bun.file(path).text();
        if (contents.split(item.from).length !== 2) throw new Error(`The OpenCode runtime relocation no longer matches ${path}`);
        if ("asset" in item) assets.set(item.asset, join(dirname(path), item.asset));
        return { contents: contents.replace(item.from, item.to), loader: "js" };
      });
    }
  },
};

const result = await Bun.build({
  entrypoints: [source],
  outdir: output,
  target: "bun",
  splitting: true,
  metafile: true,
  minify: { whitespace: true },
  naming: { chunk: "pipe-worker-[hash].[ext]", asset: "[name].[ext]" },
  // Like the official CLI, resolve node-gyp at runtime. OpenCode's own npm installs ignore scripts.
  external: ["@anthropic-ai/claude-agent-sdk", "node-gyp"],
  plugins: [relocations],
});
if (!result.success || result.metafile === undefined) throw new Error("Bun did not produce the OpenCode runtime or its metadata");
if (!existsSync(join(output, "photon_rs_bg.wasm")) || !assets.has("node-gyp-bin")) throw new Error("The OpenCode runtime is missing its bundled resource paths");
for (const [name, path] of assets) cpSync(path, join(output, "assets", name), { recursive: true });

// Fail packing and source startup if a future dependency leaks a build-machine path into a chunk.
const roots = new Set([realpathSync(output), realpathSync(process.cwd())]);
for (const input of Object.keys(result.metafile.inputs)) {
  const absolute = resolve(input);
  const dependencyStore = absolute.split(`${sep}node_modules${sep}`)[0];
  if (dependencyStore !== undefined && dependencyStore !== absolute) roots.add(dependencyStore);
}
for (const file of result.outputs) {
  const bytes = Buffer.from(await file.arrayBuffer());
  if ([...roots].some((root) => bytes.includes(`${root}${sep}`))) throw new Error(`Build path leaked into OpenCode runtime file ${file.path}`);
}
if (metafile !== undefined) await Bun.write(metafile, JSON.stringify(result.metafile));

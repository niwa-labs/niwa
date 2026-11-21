import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { entryName, SHARED_MODULES } from "./src/shared-modules.ts";

const require = createRequire(import.meta.url);
const PREFIX = "virtual:shared/";

/**
 * The shared modules as entries of the build. Each is a module of its own that re-exports a package, so the app and the
 * client modules of the plugins, which import the package by name through the import map, read the same copy.
 */
function sharedModules(): Plugin {
  return {
    name: "niwa-shared-modules",
    resolveId(id) {
      return id.startsWith(PREFIX) ? `\0${id}` : undefined;
    },
    load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return undefined;
      const wanted = id.slice(`\0${PREFIX}`.length);
      const shared = SHARED_MODULES.find((one) => entryName(one.name) === wanted);
      if (shared === undefined) return undefined;
      if (!shared.cjs) return `export * from ${JSON.stringify(shared.source)};\n`;
      const names = Object.keys(require(shared.source) as Record<string, unknown>).filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
      return [
        `import shared from ${JSON.stringify(shared.source)};`,
        "export default shared;",
        ...names.map((name) => `export const ${name} = shared.${name};`),
        "",
      ].join("\n");
    },
  };
}

/**
 * The page allows no eval, and zod compiles its object checks with one at the moment a schema is built. Zod reads its
 * configuration from this global when it loads, so a classic script of the page sets it before any module runs: a
 * statement in a module would run after the modules it imports, which the bundle puts ahead of it.
 */
const NO_EVAL = "globalThis.__zod_globalConfig = { jitless: true };\n";
const NO_EVAL_FILE = `assets/no-eval-${createHash("sha256").update(NO_EVAL).digest("hex").slice(0, 8)}.js`;

function noEval(): Plugin {
  return {
    name: "niwa-no-eval",
    buildStart() {
      this.emitFile({ type: "asset", fileName: NO_EVAL_FILE, source: NO_EVAL });
    },
    transformIndexHtml: () => [{ tag: "script", attrs: { src: `/${NO_EVAL_FILE}` }, injectTo: "head-prepend" as const }],
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), sharedModules(), noEval()],
  resolve: { dedupe: ["react", "react-dom", "@tanstack/react-query", "zod"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        ...Object.fromEntries(SHARED_MODULES.map((one) => [entryName(one.name), `${PREFIX}${entryName(one.name)}`])),
      },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});

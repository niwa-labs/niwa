import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

export const NOTICE_ASSET = "assets/THIRD-PARTY-LICENSES.txt";

const require = createRequire(import.meta.url);
const NOTICE_DIRECTORY = new URL("../notices/", import.meta.url);
const SHIKI_VERSION = "4.6.0";

function manifestAt(root: string): { name: string; version: string } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
}

function upstreamNotice(file: string): string {
  return readFileSync(new URL(file, NOTICE_DIRECTORY), "utf8");
}

/** Vite collects a license per JavaScript package. Also carry CSS and transitive attribution. */
export function thirdPartyNotices(): Plugin {
  return {
    name: "niwa-third-party-notices",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_, bundle) {
        const report = bundle[NOTICE_ASSET];
        if (report?.type !== "asset" || typeof report.source !== "string") {
          throw new Error("Vite did not generate the third-party license report");
        }
        const modules = Object.values(bundle).flatMap((output) => output.type === "chunk" ? output.moduleIds : []);
        const packages = new Map<string, Set<string>>();
        for (const id of modules) {
          const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(id);
          if (id.startsWith("\0") || match === null) continue;
          const [, root = "", file = ""] = match;
          let files = packages.get(root);
          if (files === undefined) packages.set(root, files = new Set());
          files.add(file);
        }

        const notices = new Map<string, string>();
        const tailwindRoot = dirname(require.resolve("tailwindcss/package.json"));
        const { version: tailwindVersion } = manifestAt(tailwindRoot);
        notices.set(`tailwindcss - ${tailwindVersion} (MIT)`, readFileSync(join(tailwindRoot, "LICENSE"), "utf8"));
        notices.set("Apache License, Version 2.0", upstreamNotice("apache-2.0.txt"));

        for (const [root, files] of packages) {
          const { name, version } = manifestAt(root);
          for (const file of readdirSync(root, { withFileTypes: true })) {
            if (file.isFile() && /^notices?(?:[._-]|$)/i.test(file.name)) {
              notices.set(`${name} - ${version} (${file.name})`, readFileSync(join(root, file.name), "utf8"));
            }
          }
          if (name === "@shikijs/langs" || name === "@shikijs/themes" || name === "@shikijs/engine-oniguruma") {
            if (version !== SHIKI_VERSION) throw new Error(`Update Cockpit's upstream notices for ${name}@${version}`);
          }
          if (name === "@shikijs/langs") {
            notices.set("tm-grammars - 1.32.22 (NOTICE)", upstreamNotice("tm-grammars-1.32.22.NOTICE"));
            notices.set("TextMate grammar and theme source revisions", upstreamNotice("textmate-source-revisions.txt"));
          }
          if (name === "@shikijs/themes") {
            notices.set("tm-themes - 1.12.12 (NOTICE)", upstreamNotice("tm-themes-1.12.12.NOTICE"));
          }
          if (name === "@shikijs/engine-oniguruma" && files.has("dist/wasm-inlined.mjs")) {
            notices.set("vscode-oniguruma - 1.7.0 (LICENSE.txt)", upstreamNotice("vscode-oniguruma-1.7.0.LICENSE.txt"));
            notices.set("vscode-oniguruma - 1.7.0 (NOTICES.txt)", upstreamNotice("vscode-oniguruma-1.7.0.NOTICES.txt"));
          }
        }

        for (const [title, notice] of [...notices].sort(([first], [second]) => first.localeCompare(second, "en"))) {
          report.source += `\n## ${title}\n\n${notice}\n`;
        }
      },
    },
  };
}

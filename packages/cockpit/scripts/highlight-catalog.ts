import type { Plugin } from "vite";

/** Language grammar origins and grants are listed in notices/textmate-source-revisions.txt. */
export const GRAMMARS = new Set([
  "bat", "c", "css", "diff", "docker", "git-commit", "git-rebase", "go", "html", "ini", "java",
  "javascript", "json", "jsonc", "jsonl", "jsx", "lua", "make", "markdown", "perl", "php",
  "powershell", "python", "regexp", "rust", "shellscript", "sql", "toml", "tsx", "typescript",
  "xml", "yaml", "zig",
]);

export const SHIKI_THEMES = new Set(["github-dark", "github-light"]);
export const PIERRE_THEMES = new Set(["pierre-dark", "pierre-light"]);

function narrowCatalog(source: string, variable: string, allow: Set<string>): string {
  const prefix = "const " + variable + " = [\n";
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf("\n];", start);
  const original = source.slice(start, end);
  const rows = original.match(/\t\{\n[\s\S]*?\n\t\}/g);
  if (!source.includes(prefix) || end < 0 || !rows || rows.join(",\n") !== original) {
    throw new Error("Review the changed Shiki catalog format for " + variable);
  }
  const seen = new Set<string>();
  const included = rows.filter((row) => {
    const name = /^\t\t"id": "([^"]+)",$/m.exec(row)?.[1];
    if (name === undefined) throw new Error("Shiki catalog entry is missing its id in " + variable);
    if (!allow.has(name)) return false;
    seen.add(name);
    return true;
  });
  if (seen.size !== allow.size) throw new Error("A reviewed entry is missing from Shiki's " + variable);
  return source.slice(0, start) + included.join(",\n") + source.slice(end);
}

const SHIKI_LANG_CATALOG = /\/node_modules\/shiki\/dist\/langs-bundle-full-[^/]+\.mjs$/;
const SHIKI_THEME_CATALOG = "/node_modules/shiki/dist/themes.mjs";
const PIERRE_SHIKI_CATALOG = "/node_modules/@pierre/theming/dist/collections/shiki.js";
const PIERRE_THEME_CATALOG = "/node_modules/@pierre/highlights/dist/themes/loader.js";

function allowedArtifact(id: string): boolean {
  const shiki = /\/node_modules\/@shikijs\/(langs|themes)\/dist\/([^/]+)\.mjs$/.exec(id);
  if (shiki) return (shiki[1] === "langs" ? GRAMMARS : SHIKI_THEMES).has(shiki[2]!);
  const pierre = /\/node_modules\/@pierre\/highlights\/dist\/themes\/([^/]+)\.js$/.exec(id);
  return !pierre || pierre[1] === "loader" || PIERRE_THEMES.has(pierre[1]!);
}

/** Keep the catalogs local and fail the build if an unreviewed payload comes in through another import. */
export function highlightCatalog(): Plugin {
  return {
    name: "niwa-highlight-catalog",
    apply: "build",
    enforce: "pre",
    transform(source, id) {
      if (SHIKI_LANG_CATALOG.test(id)) return narrowCatalog(source, "bundledLanguagesInfo", GRAMMARS);
      if (id.endsWith(SHIKI_THEME_CATALOG)) return narrowCatalog(source, "bundledThemesInfo", SHIKI_THEMES);
      if (id.endsWith(PIERRE_SHIKI_CATALOG)) {
        return 'import { createThemeCollection } from "../modules/createThemeCollection.js";\n' +
          'export const shikiThemes = createThemeCollection({ themes: [] });';
      }
      if (id.endsWith(PIERRE_THEME_CATALOG)) {
        const themes = [...PIERRE_THEMES].map((name) =>
          JSON.stringify(name) + ": () => import(" + JSON.stringify("@pierre/highlights/themes/" + name) + ")");
        return "export const themes = { " + themes.join(", ") + " };";
      }
    },
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of output.moduleIds) {
          if (!allowedArtifact(id)) this.error("Unreviewed Cockpit highlight payload: " + id);
        }
      }
    },
  };
}

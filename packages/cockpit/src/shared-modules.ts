/**
 * The modules the cockpit and the client modules of the plugins share: one copy of each, served by the app and resolved
 * by the import map of the page. A client module is built with these names left as imports.
 *
 * `cjs` modules are CommonJS packages: the app names their exports so that a module can import them by name. `defaultExport`
 * marks an ES module whose default export is part of what it offers.
 *
 * The list is the whole contract: a client module is built with exactly these specifiers left as imports, and the import map of
 * the page names exactly these. Any other specifier of these packages is not shared, and the module's build refuses it.
 */

import { createRequire } from "node:module";

export type SharedModule = {
  /** The name a module imports it by. */
  readonly name: string;
  /** The package it is the entry of. */
  readonly source: string;
  /** Whether the package is CommonJS: its exports are copied name by name. */
  readonly cjs: boolean;
  /** Whether the package has a default export that a module may import. */
  readonly defaultExport?: boolean;
};

export const SHARED_MODULES: readonly SharedModule[] = [
  { name: "react", source: "react", cjs: true },
  { name: "react/jsx-runtime", source: "react/jsx-runtime", cjs: true },
  { name: "react/compiler-runtime", source: "react/compiler-runtime", cjs: true },
  { name: "react-dom", source: "react-dom", cjs: true },
  { name: "react-dom/client", source: "react-dom/client", cjs: true },
  { name: "@tanstack/react-query", source: "@tanstack/react-query", cjs: false },
  { name: "@niwa-labs/cockpit-sdk", source: "@niwa-labs/cockpit-sdk", cjs: false },
  { name: "@niwa-labs/ui-kit", source: "@niwa-labs/ui-kit", cjs: false },
  { name: "zod", source: "zod", cjs: false, defaultExport: true },
  { name: "zod/v4", source: "zod/v4", cjs: false, defaultExport: true },
];

/** The name of the app's entry that serves a shared module: `shared-react-jsx-runtime`. */
export function entryName(name: string): string {
  return `shared-${name.replace(/^@/, "").replaceAll("/", "-")}`;
}

const requireFrom = createRequire(import.meta.url);

/** The source of the module that serves a shared module: it re-exports the package, its default export included. */
export function entrySource(shared: SharedModule): string {
  const source = JSON.stringify(shared.source);
  if (!shared.cjs) {
    return [`export * from ${source};`, ...(shared.defaultExport === true ? [`export { default } from ${source};`] : []), ""].join("\n");
  }
  const names = Object.keys(requireFrom(shared.source) as Record<string, unknown>).filter(
    (name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name),
  );
  return [`import shared from ${source};`, "export default shared;", ...names.map((name) => `export const ${name} = shared.${name};`), ""].join("\n");
}

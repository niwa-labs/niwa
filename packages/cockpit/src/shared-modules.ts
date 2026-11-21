/**
 * The modules the cockpit and the client modules of the plugins share: one copy of each, served by the app and resolved
 * by the import map of the page. A client module is built with these names left as imports.
 *
 * `cjs` modules are CommonJS packages: the app names their exports so that a module can import them by name.
 */

export type SharedModule = {
  /** The name a module imports it by. */
  readonly name: string;
  /** The package it is the entry of. */
  readonly source: string;
  /** Whether the package is CommonJS: its exports are copied name by name. */
  readonly cjs: boolean;
};

export const SHARED_MODULES: readonly SharedModule[] = [
  { name: "react", source: "react", cjs: true },
  { name: "react/jsx-runtime", source: "react/jsx-runtime", cjs: true },
  { name: "react-dom", source: "react-dom", cjs: true },
  { name: "react-dom/client", source: "react-dom/client", cjs: true },
  { name: "@tanstack/react-query", source: "@tanstack/react-query", cjs: false },
  { name: "@niwa-labs/cockpit-sdk", source: "@niwa-labs/cockpit-sdk", cjs: false },
  { name: "@niwa-labs/ui-kit", source: "@niwa-labs/ui-kit", cjs: false },
  { name: "zod", source: "zod", cjs: false },
];

/** The name of the app's entry that serves a shared module: `shared-react-jsx-runtime`. */
export function entryName(name: string): string {
  return `shared-${name.replace(/^@/, "").replaceAll("/", "-")}`;
}

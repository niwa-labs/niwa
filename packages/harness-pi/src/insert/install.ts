/**
 * install.ts — put the insert into pi.
 *
 * pi loads every extension it finds in `<agent dir>/extensions`, so the insert is a small file
 * there. It sets where the host is, the program to report through and the installation the
 * sessions belong to, unless the process already says (a pi niwa started carries its own), and then
 * hands pi the extension of this package.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NIWA_CLI_ENV } from "@niwa-labs/harness";

import { PI_INSTANCE_ENV } from "./insert.ts";

/** The name of the file the insert is written to, in pi's extensions directory. */
export const PI_EXTENSION_FILE = "niwa-insert.ts";

/** What the installed extension is told. */
export interface PiInstallOptions {
  /** The home of the niwa host the insert reports to. */
  readonly home: string;
  /** The program that runs niwa's CLI, which the insert reports through. Default: `niwa` from the PATH. */
  readonly cli?: string;
  /** The id of the installation the sessions belong to. */
  readonly harness: string;
}

/** The extension of this package: the file the installed one hands pi. */
function extensionPath(): string {
  return fileURLToPath(new URL("./extension.ts", import.meta.url));
}

/** The text of the installed extension. */
export function piExtensionSource(options: PiInstallOptions): string {
  return [
    "// Written by niwa: it reports what pi does that cannot be seen from outside. Install it again to change it.",
    `import niwaPiExtension from ${JSON.stringify(extensionPath())};`,
    "",
    `process.env.NIWA_HOME ??= ${JSON.stringify(options.home)};`,
    ...(options.cli === undefined ? [] : [`process.env.${NIWA_CLI_ENV} ??= ${JSON.stringify(options.cli)};`]),
    `process.env.${PI_INSTANCE_ENV} ??= ${JSON.stringify(options.harness)};`,
    "",
    "export default niwaPiExtension;",
    "",
  ].join("\n");
}

/**
 * Write the insert into the agent directory of a pi installation. The file written is returned.
 */
export async function installPiInsert(agentDir: string, options: PiInstallOptions): Promise<string> {
  const dir = join(agentDir, "extensions");
  await mkdir(dir, { recursive: true });
  const file = join(dir, PI_EXTENSION_FILE);
  await writeFile(file, piExtensionSource(options), "utf8");
  return file;
}

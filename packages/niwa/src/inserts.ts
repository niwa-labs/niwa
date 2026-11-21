/**
 * inserts.ts — how an insert inside a harness reaches niwa when `niwa` is not on the PATH.
 *
 * An insert reports by running `niwa insert report`. It needs the program that runs niwa's CLI,
 * and the PATH of the process it lives in may not hold one. This package knows where its own
 * bin is, so what it installs records that absolute path.
 */

import { fileURLToPath } from "node:url";

import { NIWA_CLI_ENV, reportThroughCli } from "@niwa-labs/harness";
import type { HarnessKindDefinition } from "@niwa-labs/harness";
import type { InsertReporter } from "@niwa-labs/harness-pi";

/** The program that runs niwa's CLI: the bin of this package, by absolute path. It runs on its own. */
export const NIWA_CLI = fileURLToPath(new URL("../bin/niwa.ts", import.meta.url));

/**
 * Put the insert of a kind into its harness, reporting to the host at `home`.
 *
 * What the installer writes carries `NIWA_CLI`, so the insert runs the bin it was installed from
 * whatever its PATH holds. A kind with no insert, or one that is not put into the harness, is left
 * as it is.
 */
export async function installInsert(kind: HarnessKindDefinition, home: string): Promise<void> {
  await kind.insert?.install?.({ home, cli: NIWA_CLI });
}

/**
 * The environment an insert that reads it needs: where the host is, and the program to report
 * through. A pi that is started with it loads its extension and reports without a `niwa` on the PATH.
 */
export function insertEnv(home: string): Record<string, string> {
  return { NIWA_HOME: home, [NIWA_CLI_ENV]: NIWA_CLI };
}

/** A reporter for an insert that is given one: it hands each event to this package's CLI. */
export function cliReporter(home: string): InsertReporter {
  return (event) => reportThroughCli(event, { home, cli: NIWA_CLI });
}

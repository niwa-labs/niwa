/**
 * Secrets, resolved where a command starts.
 *
 * A call names a secret; its value is the owner's and is looked up here, from the file
 * `<home>/secrets/<name>` (readable by its owner alone) or from the variable `NIWA_SECRET_<name>` of
 * the host's environment. The value goes to the process and to the scrubber, and nowhere else: not
 * to a record, not to a message. Every message here names the secret, never its value.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CatchableError } from "@niwa-labs/core";

/** Why a secret was not given. */
export type SecretRefusalCode = "unknown-secret" | "unsafe-secret";

/** A secret that cannot be given: the caller's to catch, since nothing ran. */
export class SecretRefusal extends CatchableError {
  override name = "SecretRefusal";
  override readonly code: SecretRefusalCode;

  constructor(code: SecretRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The directory of the secret files of a host. */
export function secretsDir(home: string): string {
  return join(home, "secrets");
}

/** The value of the secret called `name`. */
export function resolveSecret(home: string, name: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const path = join(secretsDir(home), name);
  let mode: number | undefined;
  try {
    const stat = statSync(path);
    if (stat.isFile()) mode = stat.mode;
  } catch {
    // Not a file: the environment may have it.
  }
  if (mode !== undefined) {
    if ((mode & 0o077) !== 0) {
      throw new SecretRefusal("unsafe-secret", `the file of the secret "${name}" must be readable by its owner alone (mode 0600)`);
    }
    return nonEmpty(name, readFileSync(path, "utf8").replace(/\r?\n$/, ""));
  }
  const fromEnv = env[`NIWA_SECRET_${name}`];
  if (fromEnv !== undefined) return nonEmpty(name, fromEnv);
  throw new SecretRefusal("unknown-secret", `no secret "${name}": ${path} does not exist and NIWA_SECRET_${name} is not set`);
}

function nonEmpty(name: string, value: string): string {
  if (value.length === 0) throw new SecretRefusal("unknown-secret", `the secret "${name}" is empty`);
  return value;
}

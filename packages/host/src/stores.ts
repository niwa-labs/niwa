/**
 * The stores of a host: artifacts and secrets, under its home.
 *
 * An artifact is a file named by the SHA-256 of its bytes, under `<home>/artifacts`. Bytes are
 * written to a partial file, flushed to disk, and moved to their name; the directory is flushed
 * too. So a record that points at an artifact never points at one a crash could take, and the
 * same bytes are the same file. Artifacts are never removed while the host keeps the journal that
 * points at them.
 *
 * A secret is the owner's: the file `<home>/secrets/<name>`, readable by its owner alone, or the
 * variable `NIWA_SECRET_<name>` of the host's environment. Every message here names the secret,
 * never its value.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ArtifactMissing, SecretRefusal } from "@niwa-labs/core";
import type { ArtifactRef, ArtifactStore, ArtifactWriter, SecretStore } from "@niwa-labs/core";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Flushes a directory, so a name made in it survives a crash. */
function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The artifacts of the host whose home `home` gives. */
export function artifactStore(home: () => string): ArtifactStore {
  const dir = (): string => join(home(), "artifacts");
  const fileOf = (digest: string): string => {
    if (!DIGEST.test(digest)) throw new TypeError(`not the digest of an artifact: ${JSON.stringify(digest)}`);
    return join(dir(), digest.slice("sha256:".length));
  };

  const writer = (type: string): ArtifactWriter => {
    if (type.length === 0) throw new TypeError("an artifact needs a media type");
    const at = dir();
    mkdirSync(at, { recursive: true, mode: 0o700 });
    const temp = join(at, `.partial-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o600);
    const hasher = createHash("sha256");
    let size = 0;
    let open = true;
    const close = (): void => {
      if (!open) return;
      open = false;
      closeSync(fd);
    };
    return {
      write(chunk) {
        if (!open) throw new Error("the artifact is finished");
        if (chunk.length === 0) return;
        writeSync(fd, chunk);
        hasher.update(chunk);
        size += chunk.length;
      },
      finish() {
        if (!open) throw new Error("the artifact is finished");
        fsyncSync(fd);
        close();
        const ref: ArtifactRef = { digest: `sha256:${hasher.digest("hex")}`, size, type };
        renameSync(temp, fileOf(ref.digest));
        syncDir(at);
        return ref;
      },
      discard() {
        close();
        rmSync(temp, { force: true });
      },
    };
  };

  return {
    put(bytes, type) {
      const out = writer(type);
      try {
        out.write(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
        return out.finish();
      } catch (error) {
        out.discard();
        throw error;
      }
    },
    writer,
    read(ref) {
      const path = fileOf(ref.digest);
      if (!existsSync(path)) throw new ArtifactMissing(ref.digest);
      return new Uint8Array(readFileSync(path));
    },
  };
}

/** The secrets of the host whose home `home` gives, with the environment they may also come from. */
export function secretStore(home: () => string, env: Readonly<Record<string, string | undefined>> = process.env): SecretStore {
  const nonEmpty = (name: string, value: string): string => {
    if (value.length === 0) throw new SecretRefusal("unknown-secret", `the secret "${name}" is empty`);
    return value;
  };
  return {
    get dir() {
      return join(home(), "secrets");
    },
    resolve(name) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SecretRefusal("unknown-secret", `"${name}" is not the name of a secret`);
      const path = join(this.dir, name);
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
    },
  };
}

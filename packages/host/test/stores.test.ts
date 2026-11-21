// The stores of a host: artifacts named by their bytes and durable before anything points at them,
// and secrets resolved from the owner's sources, never written down.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { ArtifactMissing, SecretRefusal } from "@niwa-labs/core";
import type { ArtifactStore, SecretStore } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { tempHome } from "@niwa-labs/testing";

const homes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of homes.splice(0)) await cleanup();
});

/** A served host, and the stores a plugin of it is given. */
async function host() {
  const home = await tempHome();
  homes.push(home.cleanup);
  const niwa = createNiwa({ home: home.path });
  let given: { artifacts: ArtifactStore; secrets: SecretStore } | undefined;
  niwa.use(plugin("stores-probe", (api) => {
    given = { artifacts: api.artifacts, secrets: api.secrets };
  }));
  await niwa.serve();
  homes.push(() => niwa.close());
  return { niwa, home: home.path, stores: given! };
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("an artifact is its bytes under their digest, read back whole, and the same bytes are one artifact", async () => {
  const { niwa, home, stores } = await host();
  const ref = stores.artifacts.put("hello world\n", "text/plain");
  expect(ref).toEqual({ digest: sha("hello world\n"), size: 12, type: "text/plain" });
  expect(new TextDecoder().decode(niwa.artifacts.read(ref))).toBe("hello world\n");
  expect(stores.artifacts.put(new TextEncoder().encode("hello world\n"), "text/plain")).toEqual(ref);
  expect(readdirSync(join(home, "artifacts"))).toEqual([ref.digest.slice("sha256:".length)]);
});

test("a written artifact is named once it is finished, and a discarded one leaves nothing", async () => {
  const { home, stores } = await host();
  const out = stores.artifacts.writer("application/json");
  out.write(new TextEncoder().encode('{"a":'));
  out.write(new TextEncoder().encode("1}"));
  expect(readdirSync(join(home, "artifacts")).filter((name) => !name.startsWith(".partial-"))).toEqual([]);
  const ref = out.finish();
  expect(ref).toEqual({ digest: sha('{"a":1}'), size: 7, type: "application/json" });
  expect(() => out.write(new Uint8Array([1]))).toThrow(/finished/);

  const dropped = stores.artifacts.writer("text/plain");
  dropped.write(new TextEncoder().encode("half"));
  dropped.discard();
  expect(readdirSync(join(home, "artifacts"))).toEqual([ref.digest.slice("sha256:".length)]);
});

test("an artifact the host does not have is said to be missing, and a name that is not a digest is refused", async () => {
  const { stores } = await host();
  expect(() => stores.artifacts.read({ digest: sha("never kept") })).toThrow(ArtifactMissing);
  expect(() => stores.artifacts.read({ digest: "sha256:../../owner.token" })).toThrow(/not the digest/);
});

const VALUE = "s3cr3t-Value-0042";

test("a secret comes from a file of the owner alone, else from the host's environment", async () => {
  const { niwa, stores } = await host();
  mkdirSync(stores.secrets.dir, { recursive: true });
  writeFileSync(join(stores.secrets.dir, "DEPLOY"), `${VALUE}\n`, { mode: 0o600 });
  expect(stores.secrets.resolve("DEPLOY")).toBe(VALUE);
  expect(niwa.secrets.resolve("DEPLOY")).toBe(VALUE);
  process.env["NIWA_SECRET_FROM_ENV"] = VALUE;
  try {
    expect(stores.secrets.resolve("FROM_ENV")).toBe(VALUE);
  } finally {
    delete process.env["NIWA_SECRET_FROM_ENV"];
  }
});

test("a secret that is not there, a file others may read, or a name that is a path is refused without its value", async () => {
  const { stores } = await host();
  mkdirSync(stores.secrets.dir, { recursive: true });
  const open = join(stores.secrets.dir, "OPEN");
  writeFileSync(open, VALUE);
  chmodSync(open, 0o644);
  const refusal = (name: string) => {
    try {
      stores.secrets.resolve(name);
    } catch (error) {
      return error as SecretRefusal;
    }
    throw new Error(`the secret "${name}" was given`);
  };
  expect(refusal("MISSING")).toMatchObject({ code: "unknown-secret", message: expect.stringContaining('"MISSING"') });
  expect(refusal("OPEN")).toMatchObject({ code: "unsafe-secret", message: expect.stringMatching(/"OPEN".*0600/) });
  expect(refusal("OPEN").message).not.toContain(VALUE);
  expect(refusal("../OPEN")).toBeInstanceOf(SecretRefusal);
  expect(existsSync(join(stores.secrets.dir, "..", "OPEN"))).toBe(false);
});

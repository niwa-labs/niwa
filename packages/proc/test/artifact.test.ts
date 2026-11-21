// The artifact of an output: named by its content, kept by the host, bounded in the result, scrubbed of secrets.

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { ArtifactRef } from "@niwa-labs/core";
import { createNiwa, tempHome } from "@niwa-labs/testing";

import { OutputCapture, Scrubber } from "../src/artifact.ts";

const enc = (text: string) => new TextEncoder().encode(text);

/** A home with the artifact store of a host over it. */
async function storeHome() {
  const home = await tempHome();
  const artifacts = createNiwa({ home: home.path }).artifacts;
  return {
    path: home.path,
    cleanup: home.cleanup,
    artifacts,
    dir: join(home.path, "artifacts"),
    text: (ref: ArtifactRef) => new TextDecoder().decode(artifacts.read(ref)),
  };
}

async function capture(secrets: string[] = [], limit = 1 << 20, tailBytes = 16) {
  const home = await storeHome();
  return { home, capture: new OutputCapture({ artifacts: home.artifacts, secrets, limit, tailBytes }) };
}

test("the artifact is the output, named by the digest of its bytes", async () => {
  const { home, capture: out } = await capture();
  try {
    out.feed("out", enc("hello "));
    out.feed("err", enc("world\n"));
    const done = out.finish();
    const sha = createHash("sha256").update("hello world\n").digest("hex");
    expect(done.output).toEqual({ digest: `sha256:${sha}`, size: 12, type: "text/plain" });
    expect(home.text(done.output)).toBe("hello world\n");
    expect(readdirSync(home.dir)).toEqual([sha]);
    expect(done.truncated).toBe(false);
  } finally {
    await home.cleanup();
  }
});

test("the same output is one artifact", async () => {
  const home = await storeHome();
  try {
    const refs = [1, 2].map(() => {
      const out = new OutputCapture({ artifacts: home.artifacts, secrets: [], limit: 100, tailBytes: 10 });
      out.feed("out", enc("same"));
      return out.finish().output;
    });
    expect(refs[0]).toEqual(refs[1]!);
    expect(readdirSync(home.dir)).toHaveLength(1);
  } finally {
    await home.cleanup();
  }
});

test("the result keeps only a bounded tail of a long output, and the artifact keeps all of it", async () => {
  const { home, capture: out } = await capture([], 1 << 20, 8);
  try {
    out.feed("out", enc("0123456789"));
    out.feed("out", enc("abcdefghij"));
    const done = out.finish();
    expect(done.tail).toBe("cdefghij");
    expect(done.output.size).toBe(20);
    expect(home.text(done.output)).toBe("0123456789abcdefghij");
  } finally {
    await home.cleanup();
  }
});

test("an output past the limit is cut in the artifact and says so; the tail is still its end", async () => {
  const { home, capture: out } = await capture([], 10, 4);
  try {
    out.feed("out", enc("0123456789"));
    out.feed("out", enc("ABCDEF"));
    const done = out.finish();
    expect(done.truncated).toBe(true);
    expect(done.output.size).toBe(10);
    expect(home.text(done.output)).toBe("0123456789");
    expect(done.tail).toBe("CDEF");
  } finally {
    await home.cleanup();
  }
});

test("a secret is replaced in the artifact and in the tail, even when two chunks split it", async () => {
  const { home, capture: out } = await capture(["hunter2-token"], 1 << 20, 64);
  try {
    out.feed("out", enc("key=hunter2"));
    out.feed("out", enc("-token and again hunter2-token\n"));
    const done = out.finish();
    const stored = home.text(done.output);
    expect(stored).toBe("key=*** and again ***\n");
    expect(done.tail).toBe("key=*** and again ***\n");
    expect(stored).not.toContain("hunter2");
  } finally {
    await home.cleanup();
  }
});

test("a secret at the very end of a stream is replaced, and a part of one that never completes is kept", () => {
  const scrub = new Scrubber(["abcdef"]);
  const first = scrub.push(enc("xx abc")).toString();
  const second = scrub.push(enc("def")).toString();
  expect(first + second + scrub.end().toString()).toBe("xx ***");
  const lone = new Scrubber(["abcdef"]);
  expect(lone.push(enc("abc")).toString() + lone.end().toString()).toBe("abc");
});

test("a discarded capture leaves no file behind", async () => {
  const { home, capture: out } = await capture();
  try {
    out.feed("out", enc("half"));
    out.discard();
    expect(existsSync(home.dir) ? readdirSync(home.dir) : []).toEqual([]);
  } finally {
    await home.cleanup();
  }
});

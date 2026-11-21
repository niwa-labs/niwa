// The artifact of an output: named by its content, durable, bounded in the result, scrubbed of secrets.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "bun:test";

import { tempHome } from "@niwa-labs/testing";

import { OutputCapture, Scrubber, artifactDir, artifactPath } from "../src/artifact.ts";

const enc = (text: string) => new TextEncoder().encode(text);

async function capture(secrets: string[] = [], limit = 1 << 20, tailBytes = 16) {
  const home = await tempHome();
  return { home, capture: new OutputCapture({ home: home.path, secrets, limit, tailBytes }) };
}

test("the artifact is the output, named by the digest of its bytes", async () => {
  const { home, capture: out } = await capture();
  try {
    out.feed("out", enc("hello "));
    out.feed("err", enc("world\n"));
    const done = out.finish();
    const sha = createHash("sha256").update("hello world\n").digest("hex");
    expect(done.output).toEqual({ digest: `sha256:${sha}`, size: 12, type: "text/plain" });
    expect(readFileSync(artifactPath(home.path, done.output), "utf8")).toBe("hello world\n");
    expect(readdirSync(artifactDir(home.path))).toEqual([sha]);
    expect(done.truncated).toBe(false);
  } finally {
    await home.cleanup();
  }
});

test("the same output is one artifact", async () => {
  const home = await tempHome();
  try {
    const refs = [1, 2].map(() => {
      const out = new OutputCapture({ home: home.path, secrets: [], limit: 100, tailBytes: 10 });
      out.feed("out", enc("same"));
      return out.finish().output;
    });
    expect(refs[0]).toEqual(refs[1]!);
    expect(readdirSync(artifactDir(home.path))).toHaveLength(1);
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
    expect(readFileSync(artifactPath(home.path, done.output), "utf8")).toBe("0123456789abcdefghij");
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
    expect(readFileSync(artifactPath(home.path, done.output), "utf8")).toBe("0123456789");
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
    const stored = readFileSync(artifactPath(home.path, done.output), "utf8");
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
    expect(existsSync(artifactDir(home.path)) ? readdirSync(artifactDir(home.path)) : []).toEqual([]);
  } finally {
    await home.cleanup();
  }
});

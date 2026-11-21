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

test("with a secret to hold back, the two streams stay in the order their chunks came", async () => {
  const { home, capture: out } = await capture(["hunter2-token"], 1 << 20, 64);
  try {
    out.feed("err", enc("first\n"));
    out.feed("out", enc("second\n"));
    out.feed("err", enc("third\n"));
    const done = out.finish();
    expect(home.text(done.output)).toBe("first\nsecond\nthird\n");
    expect(done.tail).toBe("first\nsecond\nthird\n");
  } finally {
    await home.cleanup();
  }
});

test("a secret one stream split is replaced even when the other stream spoke in between", async () => {
  const { home, capture: out } = await capture(["hunter2-token"], 1 << 20, 64);
  try {
    out.feed("out", enc("key=hunter2"));
    out.feed("err", enc("E"));
    out.feed("out", enc("-token\n"));
    const done = out.finish();
    const stored = home.text(done.output);
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("-token");
    expect(stored).toBe("key=***E\n");
    expect(done.tail).toBe(stored);
  } finally {
    await home.cleanup();
  }
});

test("a secret that two streams' ends make together is replaced where they meet", async () => {
  const { home, capture: out } = await capture(["hunter2-token"], 1 << 20, 64);
  try {
    out.feed("out", enc("a hunter2"));
    out.feed("err", enc("-token b"));
    const done = out.finish();
    const stored = home.text(done.output);
    expect(stored).toBe("a *** b");
    expect(done.tail).toBe("a *** b");
  } finally {
    await home.cleanup();
  }
});

test("a stream that holds a part of a secret back cannot make the other pile up without end", async () => {
  const { home, capture: out } = await capture(["hunter2-token"], 1 << 24, 16);
  try {
    out.feed("out", enc("hunter2"));
    const block = Buffer.alloc(64 * 1024, "e");
    for (let i = 0; i < 16; i += 1) out.feed("err", block);
    expect(out.queued).toBeLessThanOrEqual(256 * 1024 + block.length);
    out.feed("out", enc("-token"));
    const done = out.finish();
    const stored = home.text(done.output);
    expect(stored.length).toBeGreaterThanOrEqual(16 * 64 * 1024);
    expect(stored).not.toContain("hunter2-token");
  } finally {
    await home.cleanup();
  }
});

test("however the chunks of two streams are cut, a secret never reaches the artifact and the rest of each stream is kept in order", async () => {
  const secrets = ["hunter2-token", "abc"];
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 40; round += 1) {
    const pieces = Array.from({ length: 12 }, (_, i) => `[${i}]${["hunter2-token", "abc", "xyz", "hunter2", "-token", " "][random(6)]}`);
    const { home, capture: out } = await capture(secrets, 1 << 20, 4096);
    try {
      // One stream carries everything, cut at random places: what is stored is the text with the secrets replaced.
      const text = pieces.join("");
      for (let at = 0; at < text.length; ) {
        const next = Math.min(text.length, at + 1 + random(9));
        out.feed("out", enc(text.slice(at, next)));
        at = next;
      }
      const stored = home.text(out.finish().output);
      expect(stored).toBe(text.replaceAll("hunter2-token", "***").replaceAll("abc", "***"));
    } finally {
      await home.cleanup();
    }
  }
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

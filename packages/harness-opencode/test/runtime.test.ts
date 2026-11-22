import { expect, test } from "bun:test";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { OPENCODE_BUILD_DIRECTORY, buildOpenCodeWorker } from "../src/runtime.ts";

test("the OpenCode bundle is reproducible and loads Photon WASM after moving its directory", async () => {
  const root = await tempDir("opencode-runtime");
  const first = join(root, "build");
  const second = join(root, "different", "depth", "build");
  const moved = join(root, "installed");
  const metafile = join(root, "meta.json");
  try {
    await Promise.all([mkdir(first), mkdir(second, { recursive: true })]);
    buildOpenCodeWorker(first, metafile);
    buildOpenCodeWorker(second);
    const files = (await readdir(first, { recursive: true, withFileTypes: true }))
      .filter((file) => file.isFile())
      .map((file) => join(file.parentPath.slice(first.length), file.name));
    for (const file of files) {
      const expected = Buffer.from(await Bun.file(join(first, file)).arrayBuffer());
      expect(expected.includes(OPENCODE_BUILD_DIRECTORY)).toBe(false);
      expect(expected.includes(root)).toBe(false);
      expect(Buffer.from(await Bun.file(join(second, file)).arrayBuffer())).toEqual(expected);
    }

    const metadata = await Bun.file(metafile).json() as { outputs: Record<string, { inputs: Record<string, unknown> }> };
    const photonChunk = Object.entries(metadata.outputs).find(([, entry]) =>
      Object.keys(entry.inputs).some((file) => file.endsWith("photon-node/photon_rs.js")))?.[0];
    if (photonChunk === undefined) throw new Error("The OpenCode bundle did not include Photon");
    await rename(first, moved);
    const { PhotonImage } = await import(join(moved, photonChunk));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYGD4z8AAAAMEAQBsRbQRAAAAAElFTkSuQmCC", "base64");
    const image = PhotonImage.new_from_byteslice(png);
    try {
      expect([image.get_width(), image.get_height()]).toEqual([2, 1]);
    } finally {
      image.free();
    }
    const shim = join(moved, "assets", "node-gyp-bin", "node-gyp");
    expect(await Bun.file(shim).text()).toContain("$npm_config_node_gyp");
    expect((await stat(shim)).mode & 0o111).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

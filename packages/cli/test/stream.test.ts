// The command line follows one stream of a running host: `niwa log -f --json --stream`.

import { join } from "node:path";

import { expect, test } from "bun:test";

import { record } from "@niwa-labs/core";
import { z } from "zod";
import { createNiwa, plugin, tempHome, connectAsOwner } from "@niwa-labs/testing";

const Note = record("stream.note", z.object({ n: z.number() }), { open: true });
const Other = record("stream.other", z.object({ text: z.string() }), { open: true });

const COMMAND = join(import.meta.dir, "fixtures", "command.ts");

test("the CLI follows one stream", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(
    plugin("stream", (api) => {
      api.declare(Note, Other);
    }),
  );
  await niwa.serve();
  const writer = await connectAsOwner(home.path);
  let follower: ReturnType<typeof Bun.spawn> | undefined;

  try {
    const note = await writer.emit(Note, { n: 1 });
    await writer.emit(Other, { text: "not-in-this-stream" });

    follower = Bun.spawn(
      [process.execPath, COMMAND, "--home", home.path, "log", "-f", "--json", "--stream", String(note.stream)],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const reader = (follower.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("\"n\":1")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }

    // The stream it was asked for, and not the other one.
    expect(seen).toContain("stream.note");
    expect(seen).not.toContain("not-in-this-stream");
  } finally {
    follower?.kill("SIGKILL");
    await follower?.exited;
    await writer.close();
    await niwa.close();
    await home.cleanup();
  }
}, 40_000);

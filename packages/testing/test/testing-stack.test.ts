// The testing package: the base stack over a fake harness, and the re-exports that a test needs to
// run a host and speak to it without importing the core.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { actionName } from "@niwa-labs/core";
import { connect as coreConnect } from "@niwa-labs/client";
import { createNiwa as coreCreateNiwa } from "@niwa-labs/host";
import { FAKE_HARNESS, baseStack, connect, connectAsOwner, createNiwa, fakeHarness, tempHome } from "../src/index.ts";

test("testing re-exports the host and the client of the core", () => {
  expect(createNiwa).toBe(coreCreateNiwa);
  expect(connect).toBe(coreConnect);
});

test("the base stack runs a session over the fake harness, for the owner", async () => {
  const home = await tempHome();
  const stack = baseStack();
  const niwa = createNiwa({ home: home.path });
  niwa.use(...stack.plugins);
  await niwa.serve();
  const api = await connectAsOwner(home.path);
  try {
    const started = (await api.call(actionName("session.start"), { harness: FAKE_HARNESS, prompt: "move the parser" })) as {
      session: string;
    };
    expect(started.session.length).toBeGreaterThan(0);
    expect(stack.fake?.control.started).toEqual(["move the parser"]);
    const listed = (await api.call(actionName("session.list"), { managedOnly: true })) as { sessions?: unknown[] };
    expect(listed.sessions).toHaveLength(1);
  } finally {
    await api.close();
    await niwa.close();
    await home.cleanup();
  }
});

test("the base stack serves the harnesses a test gives, and no fake of its own", () => {
  const own = fakeHarness({ id: "mine", answer: { result: "ok" } });
  const stack = baseStack({ harnesses: [own.binding] });
  expect(stack.fake).toBeUndefined();
  expect(own.instance.id).toBe(own.binding.instance.id);
});

test("the pure helpers import only the contracts of the core, so they need no host", () => {
  const text = readFileSync(join(import.meta.dir, "../src/helpers.ts"), "utf8");
  const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  expect(specifiers.sort()).toEqual(["@niwa-labs/core", "@niwa-labs/core"]);
});

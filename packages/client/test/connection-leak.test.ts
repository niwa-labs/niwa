// A connection that does not come up leaves no socket behind.

import { expect, test } from "bun:test";

import { connect } from "../src/index.ts";
import { quietHost, within } from "./helpers.ts";

test("a connection whose hello cannot be built closes its socket", async () => {
  const host = quietHost();
  try {
    await expect(connect({ home: host.home, id: "has a space" })).rejects.toThrow();
    expect(host.accepted()).toBe(1);
    expect(await within(2_000, () => host.ended() === 1)).toBe(true);
  } finally {
    host.stop();
  }
});

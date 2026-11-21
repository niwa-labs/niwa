// A query the wire refuses is told to the caller at once; it is not retried as if the socket had dropped.

import { expect, test } from "bun:test";

import { connect } from "../src/index.ts";
import { quietHost } from "./helpers.ts";

test("a subscription to a query the wire does not accept fails before any connection is made", async () => {
  const host = quietHost();
  const client = await connect({ home: host.home });
  try {
    expect(() => client.records.since({ stream: "" })).toThrow(/stream: /);
    await Bun.sleep(300);
    // Only the connection of the calls was ever opened.
    expect(host.accepted()).toBe(1);
  } finally {
    await client.close();
    host.stop();
  }
});

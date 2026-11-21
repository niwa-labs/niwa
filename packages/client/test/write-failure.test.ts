// A request whose bytes the socket refused is not left behind to be sent with the next one.

import { afterEach, expect, spyOn, test } from "bun:test";

import { connect } from "../src/index.ts";

interface StubSocket {
  write(data: Uint8Array): number;
  end(): void;
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Bun.connect that hands out sockets whose writes fail while `breaking` is set. */
function stubbedSockets() {
  const written: string[] = [];
  const state = { breaking: false, opened: 0 };
  const spy = spyOn(Bun, "connect").mockImplementation((async () => {
    state.opened += 1;
    const socket: StubSocket = {
      write(data) {
        if (state.breaking) throw new Error("EPIPE");
        written.push(new TextDecoder().decode(data));
        return data.length;
      },
      end() {},
    };
    return socket;
  }) as unknown as typeof Bun.connect);
  restores.push(() => spy.mockRestore());
  return { written, state };
}

test("a call whose write failed does not start with the next call on the same client", async () => {
  const { written, state } = stubbedSockets();
  const client = await connect({ home: "/nowhere" });
  try {
    state.breaking = true;
    await expect(client.describe()).rejects.toThrow();
    state.breaking = false;
    const next = client.describe().catch(() => undefined);
    await Bun.sleep(50);
    // The next call opened a connection of its own and sent its request alone.
    expect(state.opened).toBe(2);
    expect(written.join("").split('"op":"describe"')).toHaveLength(2);
    await client.close();
    await next;
  } finally {
    await client.close();
  }
});

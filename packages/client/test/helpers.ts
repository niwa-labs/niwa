// A host that is only a socket: it lets a client connect, answers nothing, and says when a connection ended.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { socketPath } from "../src/index.ts";

export interface QuietHost {
  readonly home: string;
  /** How many connections it accepted, and how many of them ended. */
  readonly accepted: () => number;
  readonly ended: () => number;
  stop(): void;
}

export function quietHost(): QuietHost {
  const home = mkdtempSync(join(tmpdir(), "niwa-client-"));
  let accepted = 0;
  let ended = 0;
  const server = Bun.listen({
    unix: socketPath(home),
    socket: {
      open: () => {
        accepted += 1;
      },
      data: () => undefined,
      // A client that is done sends its end; one that is gone closes.
      end: (socket) => {
        ended += 1;
        socket.end();
      },
    },
  });
  return {
    home,
    accepted: () => accepted,
    ended: () => ended,
    stop: () => {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Wait until a condition holds; false when it did not within the time. */
export async function within(ms: number, holds: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (holds()) return true;
    await Bun.sleep(10);
  }
  return holds();
}

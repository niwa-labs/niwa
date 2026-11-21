// A host with the git module and nothing else, on a temporary home, for the tests of the git package.

import { realpathSync } from "node:fs";

import { createNiwa, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { git } from "../src/index.ts";
import { WorktreeRefusal } from "../src/index.ts";

/** What a test holds open, closed after it. */
export interface Opened {
  readonly hosts: Host[];
  readonly homes: Array<{ cleanup(): Promise<void> }>;
}

export function opened(): Opened {
  return { hosts: [], homes: [] };
}

export async function closeAll(held: Opened): Promise<void> {
  for (const host of held.hosts.splice(0)) await host.close().catch(() => {});
  for (const home of held.homes.splice(0)) await home.cleanup();
}

/** A served host with the git module (no cleanup timer), and its home with links resolved. */
export async function served(held: Opened): Promise<{ host: Host; home: string }> {
  const home = await tempHome();
  held.homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(git({ cleanup: false }));
  await host.serve();
  held.hosts.push(host);
  return { host, home: realpathSync(home.path) };
}

/** The refusal code a call ended with. */
export async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof WorktreeRefusal)) throw error;
    return error.code;
  }
  throw new Error("the call was not refused");
}

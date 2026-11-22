/**
 * Starts the fake opencode server (`fake-opencode-server.ts`) as a child of its own — for a data
 * directory (`FAKE_DATA_DIR`) or plain — and stops it the way a test lets a server go. The
 * address is read from the announcement line the fake prints, as the reading side reads a real
 * child's; what the fake writes of itself (its `url.log`, its request log) goes to its `cwd`.
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fake-opencode-server.ts", import.meta.url));

/** A fake server that is up, and how a test ends it. */
export interface FakeServer {
  readonly url: string;
  readonly password: string;
  stop(): Promise<void>;
}

export async function startFakeServer(options: { readonly cwd: string; readonly dataDir?: string }): Promise<FakeServer> {
  const password = randomBytes(16).toString("hex");
  const proc = Bun.spawn([process.execPath, FAKE], {
    cwd: options.cwd,
    env: {
      ...process.env,
      OPENCODE_PASSWORD: password,
      ...(options.dataDir === undefined ? {} : { FAKE_DATA_DIR: options.dataDir }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const url = await Promise.race([
      (async (): Promise<string> => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("the fake server exited before it announced itself");
          buffer += decoder.decode(value, { stream: true });
          const newline = buffer.indexOf("\n");
          if (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            if (line !== "") {
              const found = JSON.parse(line) as { readonly url?: unknown };
              if (typeof found.url === "string" && found.url !== "") return found.url;
            }
            buffer = buffer.slice(newline + 1);
          }
        }
      })(),
      Bun.sleep(10_000).then(() => {
        throw new Error("the fake server did not announce itself in time");
      }),
    ]);
    return {
      url,
      password,
      stop: async () => {
        proc.stdin.end();
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
        if (!exited) proc.kill("SIGKILL");
      },
    };
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  }
}

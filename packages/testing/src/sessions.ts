// What the tests of the sessions package need besides the shared helpers: the factory of the
// requests module, which a plugin may reach only through its records, and the function that makes
// a token of its text, which belongs to a client.

import { sandbox } from "@niwa-labs/sandbox";
import type { LaunchedBox, Sandbox, SandboxHost } from "@niwa-labs/sandbox";

export { token } from "@niwa-labs/client";
export { requests } from "@niwa-labs/requests";

/**
 * A sandbox that confines nothing: the box is planned, admitted and recorded as it would be, and its
 * process runs as a plain child. For a test whose fake harness is not what it is about.
 */
export function unconfined(name: "srt" | "nono" = "srt"): Sandbox {
  return {
    name,
    class: "process",
    available: async () => true,
    // It says what it applies as a sandbox does, though nothing holds the process to it.
    manifest: (spec) => ({
      sandbox: name,
      cwd: spec.cwd,
      env: spec.env,
      policy: {
        write: [...spec.write],
        devices: [],
        read: { except: [...spec.closed] },
        net: [...spec.net],
        ...(spec.keychainRead === undefined ? {} : { keychainRead: [...spec.keychainRead] }),
      },
    }),
    async launch(spec, argv, options): Promise<LaunchedBox> {
      const child = Bun.spawn([...argv], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: options?.detached ?? false,
      });
      return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: (signal) => child.kill(signal) };
    },
  };
}

/** A host's sandbox whose boxes confine nothing: `sessions({ sandbox: openBoxes() })`. */
export function openBoxes(): SandboxHost {
  return sandbox({ adapter: unconfined() });
}

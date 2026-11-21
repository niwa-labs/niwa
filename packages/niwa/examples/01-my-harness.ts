// Needs a live host and harnesses: running it serves a host on your real `~/.niwa`, with Claude
// Code, Codex and MiniMax Code installed under `~/.claude`, `~/.codex` and `~/.mcode`.
//
// Your harness is one file. What is connected is visible in one place.
// There are no profiles and no configuration files beside it.
//
// This program is the host: the one background process that owns the journal
// and runs the plugins. Everything else connects to it (see 10-observe.ts).

import { homedir } from "node:os";
import { join } from "node:path";

import { createNiwa } from "@niwa-labs/host";
import { git } from "@niwa-labs/git";
import { HarnessKindRegistry, harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, HarnessKindDefinition, SideCapabilities } from "@niwa-labs/harness";
import { claudeCode, claudeCodeSides } from "@niwa-labs/harness-claude";
import { codex, codexSides } from "@niwa-labs/harness-codex";
import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import { messages } from "@niwa-labs/messages";
import { owner } from "@niwa-labs/core";
import { requests } from "@niwa-labs/requests";

import { sessions } from "@niwa-labs/sessions";
import { tasks } from "@niwa-labs/tasks";
import { chatId, telegram } from "@niwa-labs/telegram";
import { timer, timers } from "@niwa-labs/timer";
import { workflow } from "@niwa-labs/workflow";
import nightDigest from "./11-plugin.ts";

const niwa = createNiwa({ home: join(homedir(), ".niwa") });
// `niwa` here is the host. The plugins it installs receive a different object, the plugin
// API, which the examples call `api` (see 11-plugin.ts). The host installs and serves; the
// plugin API declares, listens and registers.

// What is installed on this machine. A kind is code (how Claude Code, Codex, MiniMax Code are
// read and driven); an instance is one installation of it, with an id the owner gives.
// `harness.discover` can propose the instances and `harnessConfirm` registers what the owner
// confirms; here they are written out by hand.
const kinds = new HarnessKindRegistry();
const here = machineId("laptop");
function instance(kind: HarnessKindDefinition, id: string, home: string, sides: SideCapabilities): Harness {
  kinds.register(kind);
  return { id: harnessId(id), kind: kind.kind, machine: here, home, sides };
}
const installed = [
  instance(claudeCode({ harness: harnessId("claude-personal") }), "claude-personal", join(homedir(), ".claude"), claudeCodeSides),
  instance(codex(), "codex", join(homedir(), ".codex"), codexSides),
  instance(mcode({ harness: harnessId("mcode-work") }), "mcode-work", join(homedir(), ".mcode"), mcodeSides),
];
niwa.use(sessions({ harnesses: installed.map((one) => ({ instance: one })), kinds }));

// Every base module is a factory: call it, `tasks()`, `timers([...])`.
// Who a client speaks as is the composition's to say: here every client is the owner.
const bind = () => owner;
niwa.use(
  messages({ bind }),
  tasks({ messages: { bind } }),
  requests({ bind }),
  // Worktrees agents work in (`agent(prompt, { worktree: true })`). The old ones are removed by a
  // workflow the module ships, every day at four on a timer it offers: `git({ cleanup: false })` turns it off.
  git(),
  // The night digest's timer. The modules offer the timers they need themselves (git's cleanup).
  timers([timer.daily("21:00")]),
);

// A surface people reach niwa through. The token and the chat are the owner's.
niwa.use(
  telegram({
    token: process.env.TELEGRAM_TOKEN ?? "",
    owner: chatId(Number(process.env.TELEGRAM_CHAT)),
    // Without it the instance is a plain client, and the owner's requests are not answered by it.
    speaksFor: "owner",
  }),
);

// The MCP server and the web cockpit are not plugins: they are clients of this host, started
// beside it (`niwa mcp`, `niwa web`, or `serveMcp` / `serveWeb` from
// `@niwa-labs/mcp` and `@niwa-labs/web`). They connect to the socket like any other client.

// Built-in workflows (git's cleanup, say) are scripts a plugin ships: the workflow module, installed
// after the plugins that ship them, registers and installs them when the host starts. A host with a
// plugin that ships one and no workflow module refuses to serve.
niwa.use(workflow({ harnesses: ["claude-personal"] }));

// Your own plugins.
niwa.use(nightDigest);

await niwa.serve();

// `serve()` returns as soon as the host is up. It does not run until it is killed.
// The process stays alive because the host listens on its socket, so a program
// that is only the host can end here. A script that serves and then does its own
// work keeps going after this line, and stops the host with `await niwa.close()`.

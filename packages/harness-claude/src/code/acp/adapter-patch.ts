/**
 * The source anchors niwa replaces as Claude Code's ACP adapter loads (`adapter.ts`).
 * An adapter build with missing anchors fails to load.
 */

/** One change: what it does, the line as the adapter has it, and the line niwa runs instead. */
export interface AdapterPatch {
  readonly what: string;
  readonly from: string;
  readonly to: string;
}

export const ADAPTER_PATCHES: readonly AdapterPatch[] = [
  {
    what: "begin creating a session",
    from: "async createSession(params, creationOpts = {}) {",
    to: `async createSession(params, creationOpts = {}) {
        const niwaStartup = new globalThis.NiwaClaudeStartupDiagnostics();
        let niwaStage = "settings";
        try {`,
  },
  {
    what: "load Claude settings before creating a query",
    from: "await settingsManager.initialize();",
    to: 'await settingsManager.initialize();\n        niwaStage = "query";',
  },
  {
    what: "receive Claude stderr",
    from: "stderr: (err) => this.logger.error(err),",
    to: "stderr: niwaStartup.stderr,",
  },
  {
    what: "initialize the query and discover models",
    from: `const initializationResult = await q.initializationResult();
        const models = await getAvailableModels(q, initializationResult.models, settingsManager);`,
    to: `niwaStage = "initializationResult";
        const initializationResult = await q.initializationResult();
        niwaStage = "model discovery";
        const models = await getAvailableModels(q, initializationResult.models, settingsManager);`,
  },
  {
    what: "finish creating the session",
    from: `    }
}
async function getAvailableModels(`,
    to: `        } catch (error) {
            niwaStartup.error(error);
            throw RequestError.internalError(niwaStartup.report(niwaStage));
        } finally {
            niwaStartup.finishStderr();
        }
    }
}
async function getAvailableModels(`,
  },
  {
    what: "switch AskUserQuestion off",
    from: 'const disallowedTools = ["AskUserQuestion"];',
    to: 'const disallowedTools = params._meta?.niwa?.askUserQuestion === true ? [] : ["AskUserQuestion"];',
  },
  {
    what: "give every session Claude Code's preset of tools",
    from: 'tools: { type: "preset", preset: "claude_code" },',
    to: 'tools: Array.isArray(params._meta?.niwa?.tools) ? params._meta.niwa.tools : { type: "preset", preset: "claude_code" },',
  },
  {
    what: "put niwa's guard before every tool call",
    from: "hooks: [createPreToolUseHook(settingsManager, this.logger)],",
    to: "hooks: [...globalThis.niwaToolGuardHooks(params._meta?.niwa), createPreToolUseHook(settingsManager, this.logger)],",
  },
];

/** The adapter's source with every change made, or an error naming the one it does not have. */
export function patchAdapter(source: string, path: string): string {
  let patched = source;
  for (const patch of ADAPTER_PATCHES) {
    if (!patched.includes(patch.from)) {
      throw new Error(`the Claude Code ACP adapter at ${path} does not ${patch.what} the way niwa expects`);
    }
    patched = patched.replace(patch.from, patch.to);
  }
  return patched;
}

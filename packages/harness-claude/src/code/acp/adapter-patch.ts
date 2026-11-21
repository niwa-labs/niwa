/**
 * The lines niwa's entry changes in the source of Claude Code's ACP adapter as it loads
 * (`adapter.ts`). Each is replaced whole; a source that lacks one is a build of the adapter niwa
 * does not know, and it fails to load: a session must never run with a tool on by accident, or
 * off silently.
 */

/** One change: what it does, the line as the adapter has it, and the line niwa runs instead. */
export interface AdapterPatch {
  readonly what: string;
  readonly from: string;
  readonly to: string;
}

export const ADAPTER_PATCHES: readonly AdapterPatch[] = [
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

/**
 * The ACP adapter niwa runs for Claude Code: `@zed-industries/claude-code-acp`, with one thing
 * changed.
 *
 * The adapter switches `AskUserQuestion` off for every session, and carries no way to ask the
 * client a question: its permission request has nowhere to put an answer. niwa answers the
 * questions of its sessions, so this entry:
 *
 * - lets a session that asks for it (`_meta.niwa.askUserQuestion` in `session/new` or
 *   `session/load`) keep the tool; every other session has it off as before;
 * - sends the tool's questions to the client as the extension request `_niwa/ask_user_question`
 *   and hands the client's answers to the tool; when the tool call is aborted it says so with the
 *   notification `_niwa/cancel_request`;
 * - tells the client the model the session really runs, with the notification `_niwa/session_model`:
 *   the `system/init` message of the program names it, and the adapter drops that message.
 *
 * The switch is one line in the adapter's source, replaced as the adapter loads. The adapter is
 * pinned to one version, and a version that does not have the line fails to start: a session
 * must never run with the tool on by accident, or off silently.
 */

const SWITCH = 'const disallowedTools = ["AskUserQuestion"];';
const OPT_IN = 'const disallowedTools = params._meta?.niwa?.askUserQuestion === true ? [] : ["AskUserQuestion"];';

Bun.plugin({
  name: "niwa-claude-code-adapter",
  setup(build) {
    build.onLoad({ filter: /claude-code-acp\/dist\/acp-agent\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      if (!source.includes(SWITCH)) {
        throw new Error(`the Claude Code ACP adapter at ${path} does not switch AskUserQuestion off the way niwa expects`);
      }
      return { contents: source.replace(SWITCH, OPT_IN), loader: "js" };
    });
  },
});

const { ClaudeAcpAgent, applyEnvironmentSettings, loadManagedSettings, runAcp } = await import("@zed-industries/claude-code-acp");

/** What the client answers to the questions of one tool call. */
interface QuestionAnswers {
  readonly answers?: Readonly<Record<string, string>>;
  readonly cancelled?: boolean;
}

const canUseTool = ClaudeAcpAgent.prototype.canUseTool;

ClaudeAcpAgent.prototype.canUseTool = function (this: InstanceType<typeof ClaudeAcpAgent>, sessionId) {
  const adapters = canUseTool.call(this, sessionId);
  return async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion") return await adapters(toolName, input, options);
    const questions: unknown = input.questions;
    const cancelled = (): void => {
      void this.client.extNotification("_niwa/cancel_request", { sessionId, toolCallId: options.toolUseID }).catch(() => {});
    };
    options.signal.addEventListener("abort", cancelled, { once: true });
    try {
      const reply = (await this.client.extMethod("_niwa/ask_user_question", {
        sessionId,
        toolCallId: options.toolUseID,
        questions,
      })) as QuestionAnswers;
      if (reply.cancelled === true || reply.answers === undefined) {
        return { behavior: "deny", message: "The user did not answer the question." };
      }
      return { behavior: "allow", updatedInput: { ...input, answers: reply.answers } };
    } catch (error) {
      return { behavior: "deny", message: `The question could not be asked: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      options.signal.removeEventListener("abort", cancelled);
    }
  };
};

/**
 * Forwards the model of the session's `system/init` message to the client.
 *
 * The messages of the program are read by the adapter through the `next` of the session's query,
 * so that is where the init message is seen. A session the adapter did not make is not one to guess
 * about: it fails, as the switch above does, rather than leaving the model unreported.
 */
function forwardModel(agent: InstanceType<typeof ClaudeAcpAgent>, sessionId: string): void {
  const query = agent.sessions[sessionId]?.query;
  if (query === undefined) throw new Error(`the Claude Code ACP adapter made no session ${sessionId} to report the model of`);
  const next = query.next.bind(query);
  query.next = async (...args) => {
    const step = await next(...args);
    if (step.done !== true && step.value.type === "system" && step.value.subtype === "init") {
      void agent.client.extNotification("_niwa/session_model", { sessionId, model: step.value.model }).catch(() => {});
    }
    return step;
  };
}

const newSession = ClaudeAcpAgent.prototype.newSession;
const loadSession = ClaudeAcpAgent.prototype.loadSession;

ClaudeAcpAgent.prototype.newSession = async function (this: InstanceType<typeof ClaudeAcpAgent>, params) {
  const created = await newSession.call(this, params);
  forwardModel(this, created.sessionId);
  return created;
};

ClaudeAcpAgent.prototype.loadSession = async function (this: InstanceType<typeof ClaudeAcpAgent>, params) {
  const loaded = await loadSession.call(this, params);
  forwardModel(this, params.sessionId);
  return loaded;
};

// What the adapter's own entry does before it serves: the managed settings, and stdout kept for ACP.
const managedSettings = loadManagedSettings();
if (managedSettings) applyEnvironmentSettings(managedSettings);
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
runAcp();
process.stdin.resume();

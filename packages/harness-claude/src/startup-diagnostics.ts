/** Keep fixed diagnostic labels from startup failures, which can contain private data. */
const signals = [
  ["permission denied", /\b(?:EACCES|EPERM)\b|operation not permitted|permission denied/i],
  ["missing file or executable", /\bENOENT\b|no such file or directory|command not found/i],
  ["not signed in", /not signed in|not logged in|authentication required|please (?:run [^\n]*\/login|log in)/i],
  ["host API key unavailable", /Claude host API key unavailable/i],
  ["authentication rejected", /\bauthentication_failed\b|invalid x-api-key|\bAPI Error: 401\b/i],
  ["network denied", /\b(?:CONNECT tunnel failed, response 403|proxy (?:CONNECT|response|status)(?: code)?[: ]+403|(?:destination|domain) (?:blocked|denied) by (?:the )?proxy)\b/i],
  ["nested Claude session refused", /cannot be launched inside another claude code session|nested claude code session/i],
  ["unsupported command-line option", /unknown (?:option|flag)|unrecognized option/i],
  ["invalid configuration", /failed to (?:load|parse) settings|invalid (?:settings|configuration)/i],
  ["network failure", /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|unable to connect|connection error|certificate verify failed/i],
  ["model selection failed", /unknown model|invalid model|reading ['"]value['"]/i],
] as const;

const adapterStages = ["settings", "query", "initializationResult", "model discovery"] as const;
type AdapterStage = (typeof adapterStages)[number];
const TEXT_LIMIT = 4_096;

export class StartupDiagnostics {
  readonly #signals = new Set<string>();
  #carry: string | undefined = "";
  #stderrSeen = false;
  #exit: number | undefined;

  stderr = (chunk: string): void => {
    if (this.#carry === undefined) return;
    this.#stderrSeen ||= chunk.trim() !== "";
    this.#inspect(this.#carry + chunk.slice(0, TEXT_LIMIT));
    const tail = chunk.slice(-TEXT_LIMIT);
    if (chunk.length > TEXT_LIMIT) this.#inspect(tail);
    this.#carry = (this.#carry + tail).slice(-256);
  };

  finishStderr(): void {
    this.#carry = undefined;
  }

  exit(code: number | null): void {
    if (code !== null && Number.isSafeInteger(code) && code >= 0 && code <= 255) this.#exit = code;
  }

  error(error: unknown, depth = 0): void {
    if (typeof error === "string") {
      this.#inspect(error.slice(0, TEXT_LIMIT));
    } else if (typeof error === "object" && error !== null && depth < 2) {
      const fields = error as Record<string, unknown>;
      for (const key of ["message", "code", "details", "cause", "error"]) this.error(fields[key], depth + 1);
    }
  }

  #inspect(text: string): void {
    for (const [label, pattern] of signals) if (pattern.test(text)) this.#signals.add(label);
  }

  report(stage: AdapterStage) {
    return { claudeStartup: { stage, signals: [...this.#signals], stderr: this.#stderrSeen } };
  }

  /** Read fixed labels from the pinned adapter and classify legacy ACP error details in place. */
  rpc(method: string, outcome: { readonly code?: number; readonly error: string; readonly data?: unknown; readonly timedOut?: true }): string {
    const data = outcome.data as { claudeStartup?: { stage?: unknown; signals?: unknown; stderr?: unknown } } | undefined;
    const report = data?.claudeStartup;
    const stage = adapterStages.find((candidate) => candidate === report?.stage);
    if (stage !== undefined) {
      if (Array.isArray(report?.signals)) {
        const reported = report.signals.slice(0, signals.length);
        for (const [label] of signals) if (reported.includes(label)) this.#signals.add(label);
      }
      this.#stderrSeen ||= report?.stderr === true;
    }
    this.error(outcome.error);
    this.error(outcome.data);
    if (outcome.code === -32000) this.#signals.add("not signed in");
    const code = Number.isSafeInteger(outcome.code) ? ` (RPC ${outcome.code})` : "";
    const failure = outcome.timedOut ? "timed out" : "failed";
    return this.describe(`${method}${stage === undefined ? "" : ` / ${stage}`} ${failure}${code}`);
  }

  describe(failure: string): string {
    const detail = [...this.#signals];
    if (this.#exit !== undefined) detail.push(`exit ${this.#exit}`);
    if (this.#stderrSeen && this.#signals.size === 0) detail.push("unclassified stderr");
    return detail.length === 0 ? failure : `${failure}: ${detail.join(", ")}`;
  }

  accessFailure(): string | undefined {
    const labels = ["host API key unavailable", "not signed in", "authentication rejected", "network denied", "network failure"];
    const found = labels.filter((label) => this.#signals.has(label));
    return found.length === 0 ? undefined : found.join(", ");
  }
}

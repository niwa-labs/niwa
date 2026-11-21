// Server rendering checks the markup the components produce without a browser.

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { IdChip, PhasePlan, StateRing, ToolCall, TooltipProvider, type PhasePlanPhase } from "../src/index.ts";

const phases: PhasePlanPhase[] = [
  {
    id: "build",
    title: "Build",
    state: "running",
    steps: [
      { id: "compile", title: "Compile", state: "done", meta: "4.2s" },
      { id: "test", title: "Test", state: "running" },
      { id: "ship", title: "Ship", state: "pending" },
    ],
  },
];

describe("rendering", () => {
  test("a phase plan shows recompute on settled steps and stop on running ones", () => {
    const html = renderToString(
      <TooltipProvider>
        <PhasePlan phases={phases} onRecompute={() => {}} onStop={() => {}} />
      </TooltipProvider>,
    );
    expect(html).toContain('data-slot="phase-plan"');
    expect(html.match(/aria-label="Recompute from here"/g)?.length).toBe(1);
    // The phase and the running step can be stopped.
    expect(html.match(/aria-label="Stop"/g)?.length).toBe(2);
    expect(html).not.toContain('data-slot="guard-notice"');
  });

  test("without handlers a plan has no controls", () => {
    const html = renderToString(<PhasePlan phases={phases} />);
    expect(html).not.toContain("guard-button");
  });

  test("a tool call shows its name, state and duration", () => {
    const html = renderToString(<ToolCall name="bash" state="done" durationMs={1200} input="ls" output="a\nb" />);
    expect(html).toContain('data-tool="bash"');
    expect(html).toContain("1.2s");
    expect(html).toContain('aria-label="Done"');
  });

  test("an id chip links only when given a target", () => {
    expect(renderToString(<IdChip id="run-1f3a9c" />)).not.toContain("<a");
    expect(renderToString(<IdChip id="run-1f3a9c" href="/runs/run-1f3a9c" />)).toContain('href="/runs/run-1f3a9c"');
    expect(renderToString(<StateRing state="waiting" label="Waiting for the owner" />)).toContain(
      'aria-label="Waiting for the owner"',
    );
  });
});

// Server rendering checks the markup the components produce without a browser.

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { IdChip, StateRing, ToolCall } from "../src/index.ts";

describe("rendering", () => {
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

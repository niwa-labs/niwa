// The guarded control in a document: real timers, short windows.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GuardButton, GuardNotice, TooltipProvider, useGuardedAction } from "../src/index.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

const timing = { armMs: 1000, holdMs: 40, undoMs: 60 };

function Control({ onConfirm }: { onConfirm: () => void }) {
  const guard = useGuardedAction({ onConfirm, timing });
  return (
    <TooltipProvider>
      <GuardButton guard={guard} icon={<span>R</span>} label="Recompute from here" />
      <GuardNotice guard={guard} consequence="3 steps run again." pending="Recomputing" />
    </TooltipProvider>
  );
}

async function mount(onConfirm: () => void): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Control onConfirm={onConfirm} />));
  return { root, host };
}

function button(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-slot="guard-button"]')!;
}

/** A keyboard activation: a click event with no pointer behind it. */
async function keyPress(host: HTMLElement): Promise<void> {
  await act(async () => {
    button(host).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("guarded action", () => {
  test("two presses explain, confirm, and fire once after the undo window", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    expect(host.textContent).toContain("3 steps run again.");
    await keyPress(host);
    expect(host.textContent).toContain("Recomputing in 1s");
    expect(fired).toBe(0);
    await wait(120);
    expect(fired).toBe(1);
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    await act(async () => root.unmount());
    expect(fired).toBe(1);
  });

  test("undo during the window sends nothing", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await keyPress(host);
    const undo = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Undo"))!;
    await act(async () => undo.click());
    await wait(120);
    expect(fired).toBe(0);
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });

  test("a control that goes away during the undo window fires what was confirmed", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await keyPress(host);
    await act(async () => root.unmount());
    expect(fired).toBe(1);
  });

  test("Escape disarms", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await act(async () => {
      button(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });
});

/** The faults of the modules: what could not be loaded, and what failed while a page was drawn. */

import type { PluginFault } from "@niwa-labs/cockpit-sdk";
import { createContext, useContext, useSyncExternalStore } from "react";

/** A list of faults that components can read and anything can add to. */
export class FaultLog {
  #faults: readonly PluginFault[];
  readonly #listeners = new Set<() => void>();

  constructor(initial: readonly PluginFault[] = []) {
    this.#faults = initial;
  }

  add(fault: PluginFault): void {
    // The same failure drawn again is one fault.
    if (this.#faults.some((one) => one.plugin === fault.plugin && one.phase === fault.phase && one.place === fault.place && one.message === fault.message)) return;
    this.#faults = [...this.#faults, fault];
    for (const listener of this.#listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): readonly PluginFault[] => this.#faults;
}

export const FaultsContext = createContext<FaultLog>(new FaultLog());

export function useFaults(): readonly PluginFault[] {
  const log = useContext(FaultsContext);
  return useSyncExternalStore(log.subscribe, log.snapshot, log.snapshot);
}

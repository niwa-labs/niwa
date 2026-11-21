/**
 * What the cockpit hands to every component it renders: the host, the viewer, the record
 * stream, the registry and navigation. Module components reach it through hooks; the cockpit
 * provides it once at the root.
 */

import { createContext, useContext, type ReactNode } from "react";

import type { PluginFault } from "./contract.ts";
import type { CockpitRegistry, Services } from "./registry.ts";

/** How the cockpit moves between its pages without reloading the document. */
export interface CockpitNavigator {
  navigate(to: string, options?: { replace?: boolean | undefined }): void;
}

export type CockpitRuntime = Services & {
  registry: CockpitRegistry;
  navigator: CockpitNavigator;
  /** Report a fault of a module, such as a component that threw while rendering. */
  reportFault(fault: PluginFault): void;
};

export const CockpitContext = createContext<CockpitRuntime | null>(null);

export function CockpitProvider({ runtime, children }: { runtime: CockpitRuntime; children?: ReactNode }) {
  return <CockpitContext value={runtime}>{children}</CockpitContext>;
}

export function useCockpit(): CockpitRuntime {
  const runtime = useContext(CockpitContext);
  if (runtime === null) throw new Error("a cockpit component is rendered outside CockpitProvider");
  return runtime;
}

export function useHost(): CockpitRuntime["host"] {
  return useCockpit().host;
}

export function useViewer(): CockpitRuntime["viewer"] {
  return useCockpit().viewer;
}

export function useRegistry(): CockpitRegistry {
  return useCockpit().registry;
}

export function useNavigate(): CockpitNavigator["navigate"] {
  const { navigator } = useCockpit();
  return (to, options) => navigator.navigate(to, options);
}

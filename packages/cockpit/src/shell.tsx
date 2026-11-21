/** The frame of the cockpit: navigation, the status bar and the place a page is drawn in. */

import { FaultNotice, PageLink, PluginBoundary, Slot, useRegistry, useViewer } from "@niwa-labs/cockpit-sdk";
import type { PluginFault } from "@niwa-labs/cockpit-sdk";
import { Outlet, useRouterState } from "@tanstack/react-router";

import { useFaults } from "./faults.tsx";
import { useStatus } from "./status.tsx";

const LINK = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent";

function Navigation() {
  const registry = useRegistry();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = (path: string): boolean => (path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`));
  const own = (path: string, label: string) => (
    <PageLink to={path} className={`${LINK} ${active(path) ? "bg-accent font-medium" : ""}`}>
      {label}
    </PageLink>
  );
  return (
    <nav aria-label="Pages" className="flex min-w-0 flex-col gap-0.5">
      {own("/", "Home")}
      {registry.nav.map((item) => (
        <PageLink key={item.path} to={item.path} className={`${LINK} ${active(item.path) ? "bg-accent font-medium" : ""}`}>
          {item.icon === undefined ? null : (
            <PluginBoundary plugin={item.plugin} place="nav.icon" fallback={() => null}>
              <item.icon className="size-4 shrink-0" />
            </PluginBoundary>
          )}
          <span className="min-w-0 truncate">{item.label}</span>
        </PageLink>
      ))}
      {own("/journal", "Journal")}
    </nav>
  );
}

function Faults({ faults }: { faults: readonly PluginFault[] }) {
  if (faults.length === 0) return null;
  return (
    <div data-slot="faults" className="flex flex-col gap-1 border-b p-2">
      {faults.map((fault, index) => (
        <FaultNotice key={`${fault.plugin}:${fault.phase}:${String(index)}`} fault={fault} />
      ))}
    </div>
  );
}

export function Shell() {
  const viewer = useViewer();
  const faults = useFaults();
  const status = useStatus();
  return (
    <div data-slot="shell" className="flex h-full min-h-0 min-w-0">
      <aside className="flex w-48 shrink-0 flex-col gap-4 border-r p-3">
        <span className="px-2 text-sm font-semibold tracking-tight">niwa</span>
        <Navigation />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Faults faults={faults} />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <footer data-slot="status-bar" className="flex min-w-0 items-center gap-3 border-t px-3 py-1 text-xs text-muted-foreground">
          <span title="The feed of records">{status}</span>
          <Slot name="shell.status" />
          <span className="ml-auto min-w-0 truncate">{viewer.owner ? "owner" : viewer.id}</span>
        </footer>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex flex-col gap-2 p-6">
      <h2 className="text-lg font-semibold">There is no such page</h2>
      <PageLink to="/" className="text-sm underline-offset-2 hover:underline">
        Back to the home page
      </PageLink>
    </div>
  );
}

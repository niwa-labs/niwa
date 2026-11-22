/** The frame of the cockpit: navigation, the status bar and the place a page is drawn in. */

import { FaultNotice, PageLink, PluginBoundary, Slot, useHost, useRegistry, useViewer } from "@niwa-labs/cockpit-sdk";
import type { PluginFault } from "@niwa-labs/cockpit-sdk";
import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";

import { useFaults } from "./faults.tsx";
import { useStatus } from "./status.tsx";

const LINK = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent";

function Navigation() {
  const registry = useRegistry();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.hidePopover?.(); }, [pathname]);
  const active = (path: string): boolean => (path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`));
  const own = (path: string, label: string) => (
    <PageLink to={path} className={`${LINK} ${active(path) ? "bg-accent font-medium" : ""}`}>
      {label}
    </PageLink>
  );
  return (
    <>
    <nav aria-label="Pages" className="desk-nav">
      {own("/", "Пульт")}
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
      {own("/journal", "Журнал")}
    </nav>
    <button className="nw-site-menu-button" popoverTarget="nw-site-menu">Разделы ▾</button>
    <div className="nw-site-menu" popover="auto" id="nw-site-menu" ref={menu}>
      <nav aria-label="Все разделы" onClick={()=>menu.current?.hidePopover?.()}>
        {[{path:"/",label:"Пульт"}, ...registry.nav, {path:"/journal",label:"Журнал"}].map(item=>
          <PageLink key={item.path} to={item.path} aria-current={active(item.path)?"page":undefined}>{item.label}</PageLink>)}
      </nav>
    </div>
    </>
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
  const host = useHost();
  const stop = useMutation({ mutationFn: () => host.call("niwa.host.stop", {}) });
  const faults = useFaults();
  const status = useStatus();
  return (
    <div data-slot="shell" className="desk-shell">
      <header className="desk-bar">
        <PageLink to="/" className="desk-brand"><i aria-hidden>✳</i> niwa</PageLink>
        <Navigation />
        <span className="desk-connection">{status}</span>
      </header>
      <div className="desk-body">
        <Faults faults={faults} />
        <main>
          <Outlet />
        </main>
        <footer data-slot="status-bar" className="flex min-w-0 items-center gap-3 border-t px-3 py-1 text-xs text-muted-foreground">

          <Slot name="shell.status" />
          {viewer.can("niwa.host.stop") && <button disabled={stop.isPending || stop.isSuccess} onClick={() => {
            if (window.confirm("Остановить хост Niwa и его сессии?")) stop.mutate();
          }}>{stop.isSuccess ? "Остановка запрошена" : "Стоп хоста"}</button>}
          {stop.error && <span role="alert">{stop.error.message}</span>}
          <span className="ml-auto min-w-0 truncate">{viewer.owner ? "Владелец" : viewer.id}</span>
        </footer>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="flex flex-col gap-2 p-6">
      <h2 className="text-lg font-semibold">Страница не найдена</h2>
      <PageLink to="/" className="text-sm underline-offset-2 hover:underline">
        На пульт
      </PageLink>
    </div>
  );
}

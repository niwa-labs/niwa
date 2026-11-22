/** The cockpit's routes: the home page, the journal, and one route for each page the loaded modules registered. */

import { useEffect, useRef } from "react";
import { PageView, useRegistry, type RegisteredPage } from "@niwa-labs/cockpit-sdk";
import {
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
  type AnyRoute,
  type RouterHistory,
} from "@tanstack/react-router";

import { Home } from "./home.tsx";
import { Journal } from "./journal.tsx";
import { NotFound, Shell } from "./shell.tsx";

/** The query as strings, as the SDK gives it to a page: `?n=1` stays `"1"`. */
export function parseSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

export function stringifySearch(search: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (value !== undefined && value !== null) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** The paths the shell routes itself: no module may register them. */
export const SHELL_PATHS: readonly string[] = ["/"];

declare module "@tanstack/react-router" {
  interface HistoryState {
    deskBehind?: string;
  }
}

function HomePage() {
  const search = useSearch({ strict: false }) as Record<string, string>;
  return <Home project={search.project ?? ""} />;
}

function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="desk-panel"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        router.history.back();
      }}
    >
      <button className="desk-disclose" onClick={() => router.history.back()}>
        ← Назад
      </button>
      {children}
    </dialog>
  );
}

function RoutedPage({ page }: { page: RegisteredPage }) {
  const params = useParams({ strict: false }) as Readonly<Record<string, string>>;
  const search = useSearch({ strict: false }) as Readonly<Record<string, string>>;
  const behind = useRouterState({ select: (state) => state.location.state.deskBehind });
  const registry = useRegistry();
  const view = <PageView page={page} params={params} search={search} />;
  if (!page.panel || !behind || !behind.startsWith("/") || behind.startsWith("//")) return view;
  const url = new URL(behind, "http://localhost");
  const source = registry.pages.find((p) => !p.panel && p.path === url.pathname);
  const query = parseSearch(url.search);
  const background =
    url.pathname === "/" ? (
      <Home project={query.project ?? ""} />
    ) : source ? (
      <PageView page={source} params={{}} search={query} />
    ) : null;
  if (!background) return view;
  return (
    <>
      {background}
      <Panel title={page.title}>{view}</Panel>
    </>
  );
}

/** The router of a registry. Modules are all loaded before it is made, so its routes never change. */
function JournalPage() {
  const search = useRouterState({select: s => s.location.searchStr});
  return <Journal key={search} recordId={new URLSearchParams(search).get("record") ?? undefined}/>;
}

export function createCockpitRouter(registry: { pages: readonly RegisteredPage[] }, history?: RouterHistory) {
  const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: HomePage });
  const journal = createRoute({ getParentRoute: () => root, path: "/journal", component: JournalPage });
  const pages: AnyRoute[] = registry.pages.map((page) =>
    createRoute({ getParentRoute: () => root, path: page.path, component: () => <RoutedPage page={page} /> }),
  );
  return createRouter({
    routeTree: root.addChildren([home, journal, ...pages]),
    parseSearch,
    stringifySearch,
    ...(history === undefined ? {} : { history }),
  });
}

export type CockpitRouter = ReturnType<typeof createCockpitRouter>;

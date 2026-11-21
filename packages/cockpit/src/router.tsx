/** The cockpit's routes: the home page, the journal, and one route for each page the loaded modules registered. */

import { PageView, type RegisteredPage } from "@niwa-labs/cockpit-sdk";
import {
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
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
  for (const [key, value] of Object.entries(search)) if (value !== undefined && value !== null) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** The paths the shell routes itself: no module may register them. */
export const SHELL_PATHS: readonly string[] = ["/"];

function RoutedPage({ page }: { page: RegisteredPage }) {
  const params = useParams({ strict: false }) as Readonly<Record<string, string>>;
  const search = useSearch({ strict: false }) as Readonly<Record<string, string>>;
  return <PageView page={page} params={params} search={search} />;
}

/** The router of a registry. Modules are all loaded before it is made, so its routes never change. */
export function createCockpitRouter(registry: { pages: readonly RegisteredPage[] }, history?: RouterHistory) {
  const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: Home });
  const journal = createRoute({ getParentRoute: () => root, path: "/journal", component: Journal });
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

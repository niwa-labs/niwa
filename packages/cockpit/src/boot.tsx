/**
 * Starting the cockpit: who is looking, what the host lists, the modules loaded and set up, and only then the router.
 *
 * Modules register pages, slots and entity kinds while they are set up. The routes are made from what they registered, so
 * every module is loaded before the router exists and none is added after.
 */

import {
  catalogueSources,
  CockpitProvider,
  createRecordStream,
  createViewer,
  HostCallError,
  httpHostClient,
  loadPlugins,
  parseCatalogue,
  type CockpitRuntime,
  type HostClient,
  type PluginFault,
  type RecordStream,
} from "@niwa-labs/cockpit-sdk";
import { TooltipProvider } from "@niwa-labs/ui-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { FaultLog, FaultsContext } from "./faults.tsx";
import { createCockpitRouter, SHELL_PATHS, type CockpitRouter } from "./router.tsx";

export type BootOptions = {
  /** The origin and path prefix of the web server; the page's own origin by default. */
  base?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** How a module is imported from the address the catalogue gives. */
  importModule?: ((url: string) => Promise<unknown>) | undefined;
  history?: RouterHistory | undefined;
  /** How long a module may take to import and to set up. */
  moduleTimeoutMs?: number | undefined;
  /** How many records before the journal's end the feed starts with: what the pages see of the recent past. */
  backlog?: number | undefined;
  /** Where the stylesheets of the modules are linked. The page's own document by default. */
  document?: Document | undefined;
};

export type Cockpit = {
  runtime: CockpitRuntime;
  router: CockpitRouter;
  queryClient: QueryClient;
  faults: FaultLog;
  stream: RecordStream;
  /** Close the record feed. */
  stop(): void;
};

/** The records a page can see of the time before it opened, when the options do not say. */
export const DEFAULT_BACKLOG = 2_000;

async function readJson(doFetch: typeof fetch, url: string): Promise<unknown> {
  const response = await doFetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new HostCallError(response.status, text === "" ? `HTTP ${String(response.status)}` : text);
  }
  return response.json();
}

function linkStylesheet(document: Document, href: string): void {
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((link) => link.getAttribute("href") === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/** The viewer as the server describes it: the SDK's own shape of who is looking. */
async function readViewer(doFetch: typeof fetch, base: string) {
  const body = (await readJson(doFetch, `${base}/api/viewer`)) as { id?: unknown; owner?: unknown; actions?: unknown };
  if (typeof body.id !== "string" || typeof body.owner !== "boolean" || !Array.isArray(body.actions)) {
    throw new HostCallError(502, "the server did not say who is looking");
  }
  return createViewer({ id: body.id, owner: body.owner, actions: body.actions.filter((name): name is string => typeof name === "string") });
}

export async function bootCockpit(options: BootOptions = {}): Promise<Cockpit> {
  const base = (options.base ?? "").replace(/\/+$/, "");
  const doFetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
  const host: HostClient = httpHostClient({ base, fetch: doFetch });

  const [viewer, info, catalogue] = await Promise.all([
    readViewer(doFetch, base),
    host.info(),
    readJson(doFetch, `${base}/api/catalogue`).then(parseCatalogue),
  ]);

  const stream = createRecordStream(host);
  const seq = typeof info.seq === "number" ? info.seq : 0;
  stream.start(Math.max(0, seq - (options.backlog ?? DEFAULT_BACKLOG)));

  const document = options.document ?? (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
  if (document !== undefined) for (const module of catalogue.modules) for (const sheet of module.styles ?? []) linkStylesheet(document, `${base}${sheet}`);

  const loaded = await loadPlugins(
    catalogueSources(
      { modules: catalogue.modules.map((module) => ({ ...module, entry: `${base}${module.entry}` })) },
      options.importModule,
    ),
    { viewer, host, records: stream },
    { timeoutMs: options.moduleTimeoutMs, paths: SHELL_PATHS },
  );

  const faults = new FaultLog(loaded.faults);
  const router = createCockpitRouter(loaded.registry, options.history);
  const runtime: CockpitRuntime = {
    viewer,
    host,
    records: stream,
    registry: loaded.registry,
    navigator: {
      navigate: (to, opts) => (opts?.replace === true ? router.history.replace(to) : router.history.push(to)),
    },
    reportFault: (fault: PluginFault) => faults.add(fault),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return { runtime, router, queryClient, faults, stream, stop: () => stream.stop() };
}

export function CockpitApp({ cockpit }: { cockpit: Cockpit }) {
  return (
    <FaultsContext value={cockpit.faults}>
      <QueryClientProvider client={cockpit.queryClient}>
        <CockpitProvider runtime={cockpit.runtime}>
          <TooltipProvider>
            <RouterProvider router={cockpit.router} />
          </TooltipProvider>
        </CockpitProvider>
      </QueryClientProvider>
    </FaultsContext>
  );
}

/** What the page says when the cockpit could not start: not logged in, or the host is not reachable. */
export function startFailure(error: unknown): string {
  if (error instanceof HostCallError && error.status === 401) return "You are not logged in. Open the login link `niwa web` printed when it started.";
  return `The cockpit could not start: ${error instanceof Error ? error.message : String(error)}`;
}

/** Start the cockpit and draw it in a container; a failure to start is drawn there too. */
export async function mountCockpit(container: Element, options: BootOptions = {}): Promise<Cockpit | undefined> {
  const root = createRoot(container);
  try {
    const cockpit = await bootCockpit(options);
    root.render(
      <StrictMode>
        <CockpitApp cockpit={cockpit} />
      </StrictMode>,
    );
    return cockpit;
  } catch (error) {
    root.render(
      <p role="alert" className="p-6 text-sm">
        {startFailure(error)}
      </p>,
    );
    return undefined;
  }
}

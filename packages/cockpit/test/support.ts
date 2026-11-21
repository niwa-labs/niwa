// Stubs of the web server for the tests that start the cockpit without a browser or a host.

export type Served = Record<string, () => Response>;

/** What the stub saw: each address asked for, and the record feeds that were opened and then closed by the app. */
export type Seen = { urls: string[]; feedsOpened: number; feedsClosed: number };

export function seen(): Seen {
  return { urls: [], feedsOpened: 0, feedsClosed: 0 };
}

export function fetching(served: Served, saw: string[] | Seen): typeof fetch {
  const log = Array.isArray(saw) ? { urls: saw, feedsOpened: 0, feedsClosed: 0 } : saw;
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.urls.push(url);
    const path = url.split("?")[0] ?? "";
    if (path.endsWith("/api/events")) {
      // The feed stays open until the app closes it.
      log.feedsOpened += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            log.feedsClosed += 1;
            controller.close();
          });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    const make = served[path.replace(/^https?:\/\/[^/]+/, "")];
    return make === undefined ? new Response("no such address", { status: 404 }) : make();
  }) as typeof fetch;
}

export const json = (value: unknown): (() => Response) => () => Response.json(value);

export function module(id: string, entry = `/modules/${id}/${"a".repeat(64)}/index.js`, styles?: string[]) {
  return { id, package: `@niwa-labs/${id}`, version: "0.0.0", entry, hash: "a".repeat(64), ...(styles === undefined ? {} : { styles }) };
}

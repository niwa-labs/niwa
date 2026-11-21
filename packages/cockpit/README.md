# @niwa-labs/cockpit

The cockpit application: a React 19 app, built with Vite 8 and the React Compiler, routed with
TanStack Router and reading the host through TanStack Query. `niwa web` serves it.

It is a frame. The pages come from the client modules that plugins offer: each plugin exports a
`./cockpit` module made with `definePlugin` from `@niwa-labs/cockpit-sdk`, and the host lists the
modules in `niwa.cockpit.catalog`.

## Start

1. Ask the web server who is looking (`/api/viewer`), what the host lists (`/api/catalogue`) and
   where its journal ends (`/api/info`).
2. Start the record feed a backlog before the end of the journal.
3. Import every listed module and run its `setup`. A module that cannot be imported, or throws,
   is left out and shown as a fault; the others load.
4. Only then make the router, from the pages the modules registered. No module is added later.

The shell is the navigation, the status bar of the feed, the faults and the place a page is drawn
in. The home page is the tiles that modules put in the `home.tile` slot. The journal, at `/journal`,
shows the latest records newest first: each is drawn by the view a module gave its type in the
`record.view` slot, and by a plain row when no module did.

`/`, `/journal` and the addresses the web server answers itself (`/api`, `/assets`, `/modules`,
`/feed`, `/trace` and the rest) are the cockpit's: a module that asks for a page there is left out
and reported.

## One copy of the libraries

The build has one entry for each shared module: React, React DOM, the JSX runtime, TanStack Query,
the SDK, the kit and zod. The page carries an import map that names them, and a client module is
built with those names left as imports, so the app and every module read the same copy.

The page allows scripts only from its own origin, and no `eval`: a classic script ahead of the
modules makes zod check the plain way instead of compiling its checks.

## From the host's side

The entry (`@niwa-labs/cockpit`) imports no React. `cockpitApp()` finds the built app in `dist`,
builds it when it is missing or older than its sources, and answers the folder and the import map
that `serveWeb` takes as `app`.

```sh
bun run build   # in this package: writes dist/
```

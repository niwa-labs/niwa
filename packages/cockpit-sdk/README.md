# @niwa-labs/cockpit-sdk

The SDK for cockpit client modules. A plugin's module exports a plugin made with
`definePlugin`; the cockpit imports every module the host's catalogue lists, runs their
`setup` before it builds its routes, and renders what they registered.

```ts
import { definePlugin, entityTabSlot } from "@niwa-labs/cockpit-sdk";

export default definePlugin({
  id: "rin",
  setup(ctx) {
    ctx.pages.add({ path: "/rin", title: "Rin", nav: { order: 10 }, component: RinPage });
    ctx.slots.register(entityTabSlot("session"), { key: "rin-digest", title: "What Rin learned", component: DigestTab });
    ctx.slots.register("home.tile", { key: "rin-attention", component: AttentionTile });
    ctx.entities.register("commitment", { label: "Commitment", prefix: "com", href: (id) => `/rin/commitments/${id}` });
  },
});
```

- **Contract**: `definePlugin`, `PluginContext` (viewer, host client, record stream, pages,
  slots, entities), `SlotMap` (typed slots, extended by module augmentation), `PluginFault`.
- **Registry**: modules register into drafts; `loadPlugins` assembles them in load order and
  leaves out a module whole when it cannot be imported, its setup throws, or what it registers
  conflicts or targets an undeclared slot.
- **Catalogue**: `CockpitModuleSchema` and `parseCatalogue` for the list of modules the host
  serves; `catalogueSources` imports them by their content-addressed entries. A module that
  takes too long to import or set up is left out like one that fails.
- **Host**: `httpHostClient` calls actions and reads or follows records through the web server.
  Action references are typed through their schemas; a result is what the host sent, as JSON
  (`Wire<O>`), not decoded again. History and its live continuation take one `RecordQuery`.
- **Live records**: `createRecordStream` keeps one feed in a store; pages read projections
  (`defineProjection`, `recordList`) with `useProjection`. A projection's fold is cached by the
  projection object, so define projections at module scope. Modules see the stream read-only.
- **React**: `CockpitProvider`, `Slot`, `SlotItem`, `PageView`, `EntityLink`, `PageLink`,
  `PluginBoundary`, `useCall` and `useAction` over TanStack Query.

All modules are trusted and share one document. React, React DOM and TanStack Query are peer
dependencies: the cockpit provides one copy of them, of this SDK and of the ui-kit, and every
module uses it.

## Pages and actions

A page can offer a named action with `commands: [{ action: "task.create",
label: "Create task" }]`. Commands can also be a function of the route
parameters, for example to prefill the id of the session being viewed. The
SDK checks the viewer's grants, reads the current action schema when the
form opens, and submits to the host. A module can still provide its own
form when a workflow needs a specialized interaction.

Set `panel: true` on a detail page to open it over the referring list and
return with Escape or Back. Its URL can also be opened directly. On the
desk, use `home.summary` for counts, `home.main` for work and `home.tile`
for the sidebar. Home contributions receive the selected project and may
report the project directories in their data.

// A composition: the plugins of a host.
//
// `niwa serve <composition.ts>` runs a host from this file. The file says which plugins run
// and nothing else: the host takes the journal, the plugins do their work.

import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { z } from "zod";

/** The record the plugin writes. */
export const Ping = record("composition.ping", z.object({ text: z.string() }));

/** The plugin of the composition. */
export const composer = plugin("composition", (api) => {
  api.declare(Ping);
});

/**
 * The catalogue of cockpit modules, as the host serves it.
 *
 * A plugin on the host offers a client module; the host lists the modules it offers with a
 * content hash, and the web server serves each module's code by id and hash. The cockpit
 * imports the listed entries before it builds its routes.
 */

import { z } from "zod";

import { PLUGIN_ID } from "./contract.ts";

export const CockpitModuleSchema = z.object({
  /** The module's id; the plugin it exports has the same id. */
  id: z.string().regex(PLUGIN_ID),
  /** The package that offers the module. */
  package: z.string().min(1),
  version: z.string().min(1),
  /** The address of the module's code: an ES module that imports React and the SDK as shared modules. */
  entry: z.string().min(1),
  /** The hash of the module's code; a new hash is a new address, so caches never serve old code. */
  hash: z.string().min(1),
  /** Stylesheets the module needs, if any. */
  styles: z.array(z.string().min(1)).optional(),
});

export type CockpitModule = z.output<typeof CockpitModuleSchema>;

export const CockpitCatalogueSchema = z.object({ modules: z.array(CockpitModuleSchema) });

export type CockpitCatalogue = z.output<typeof CockpitCatalogueSchema>;

/** Read a catalogue the host answered with; a malformed one is an error, not an empty list. */
export function parseCatalogue(value: unknown): CockpitCatalogue {
  return CockpitCatalogueSchema.parse(value);
}

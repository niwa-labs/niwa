// Build the app that the package ships, into `dist/app`: `bun run build`, and the step that packing runs first.

import { ARTIFACT, buildCockpit } from "../src/index.ts";

await buildCockpit({ outDir: ARTIFACT });

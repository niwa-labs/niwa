import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { PACKED_RUNTIME, buildOpenCodeWorker } from "../src/runtime.ts";
import { writeThirdPartyNotices } from "./third-party-notices.ts";

const parent = dirname(PACKED_RUNTIME);
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(join(parent, ".opencode-runtime-"));
const metafile = join(output, "build-inputs.json");
try {
  buildOpenCodeWorker(output, metafile);
  writeThirdPartyNotices(output, metafile);
  rmSync(metafile);
  rmSync(PACKED_RUNTIME, { recursive: true, force: true });
  renameSync(output, PACKED_RUNTIME);
} finally {
  rmSync(output, { recursive: true, force: true });
}

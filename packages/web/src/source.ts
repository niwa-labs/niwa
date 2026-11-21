import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { seq } from "@niwa-labs/core";
import type { NiwaApi } from "@niwa-labs/client";

const Script = z.object({ file: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const MAX_SOURCE_BYTES = 1024 * 1024;

/** Only return the exact bytes witnessed by the workflow handler when this run started. */
export async function runSource(api: NiwaApi, position: number): Promise<string | undefined> {
  const [record] = await api.records.read({ from: seq(position - 1), limit: 1 });
  if (record?.seq !== position || record.type !== "workflow.run.started" ||
      record.actor.kind !== "handler" || !record.actor.handler.startsWith("workflow/")) return;
  const data = Script.safeParse(record.data);
  if (!data.success || !isAbsolute(data.data.file) || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(data.data.file)) return;
  const file = await open(data.data.file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (!file) return;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return;
    // The extra byte distinguishes EOF from a file that grew after stat.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        const source = bytes.subarray(0, offset);
        return createHash("sha256").update(source).digest("hex") === data.data.hash ? source.toString("utf8") : undefined;
      }
      offset += bytesRead;
    }
  } catch {
    // The recorded version cannot be read from this file anymore.
  } finally {
    await file.close();
  }
}

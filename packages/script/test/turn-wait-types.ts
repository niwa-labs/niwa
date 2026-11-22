import type { ScriptSession } from "@niwa-labs/script";
import { z } from "zod";

// Compiled by the workspace typecheck against the public SDK, independently of the workflow globals.
export async function checkPublicConditionalSchema(session: ScriptSession, useSchema: boolean): Promise<string> {
  const options = { label: "value", schema: useSchema ? z.number() : undefined };
  const result = await (await session.send("value", options)).wait();
  // @ts-expect-error A schema chosen at runtime can make this a number.
  result.toUpperCase();
  return typeof result === "string" ? result.toUpperCase() : result.toFixed();
}

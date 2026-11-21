/**
 * What a refusal by the host is, as the web surface tells it.
 *
 * The host refuses a call with the code `Denied`; the details of the grant that refused ride along when there is a grant to
 * name, and are absent when there is none (the switch of access is off, for one). The code decides, not the details.
 */

import { HostError } from "@niwa-labs/client";

/** Did the host refuse for a lack of permission? */
export function isDenied(error: unknown): error is HostError {
  return error instanceof HostError && (error.code === "Denied" || error.denied !== undefined);
}

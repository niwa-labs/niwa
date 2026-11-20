// How a session is named in niwa's records: the harness id and the id that harness gave it,
// written as one string so it can be a record field and a key of an index.

import { z } from "zod";

export const SessionRefSchema = z.string().min(1).brand<"SessionRef">();

export type SessionRef = z.output<typeof SessionRefSchema>;

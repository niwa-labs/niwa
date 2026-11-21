// Prints the owner token of the home named on the command line, or "none".

import { readOwnerToken } from "../../src/index.ts";

console.log(readOwnerToken(process.argv[2] ?? "") ?? "none");

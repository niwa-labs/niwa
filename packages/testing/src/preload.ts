// `bun test` does not emit `exit`, so the temporary directories a test left are removed here, after each file.

import { afterAll } from "bun:test";

import { sweepTempDirs } from "./index.ts";

afterAll(sweepTempDirs);

/**
 * The MiniMax Code harness kinds: `mcode`, the published build, and `ncode`, the owner's fork of it.
 * They read the same files and speak the same Agent Client Protocol, so they live in one package.
 */

export * from "./mcode/index.ts";
export * from "./ncode/index.ts";
export { MCODE_LAUNCH } from "./mcode/control.ts";
export { minimaxCapabilities } from "./mcode/kind.ts";
export { FIXTURE_HARNESS, writeMcodeFixtures } from "./mcode/fixtures.ts";
export { logPathOf, nativeIdFromDirName } from "./mcode/paths.ts";
export { McodeAgentNotification, McodeAgentRequest } from "./mcode/protocol.ts";
export { NcodeSessionUpdate, ncodeMarks, refusesSessionMode } from "./ncode/protocol.ts";

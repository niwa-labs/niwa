// A process that makes temporary directories the way a test does and then ends in the way argv[2] says.
// It prints the directories it made, one per line, before it ends.

import { tempDir, tempDirSync, tempHome } from "@niwa-labs/testing";

const how = process.argv[2];

const home = await tempHome();
const paths = [home.path, await tempDir("async"), tempDirSync("sync")];
console.log(paths.join("\n"));

if (how === "throw") throw new Error("the test failed before its cleanup");
if (how === "kill") process.kill(process.pid, "SIGKILL");
if (how === "term") process.kill(process.pid, "SIGTERM");
if (how === "int") process.kill(process.pid, "SIGINT");
if (how === "cleaned") await home.cleanup();
if (how === "term" || how === "int") await new Promise(() => {});

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProfileContext } from "@niwa-labs/sandbox";

/** The active package of a versioned ncode launcher and the Node installation it pins. */
export function versionedPrograms(launcher: string, context: ProfileContext): readonly string[] | undefined {
  if (basename(launcher) !== "ncode" || basename(dirname(launcher)) !== "bin") return undefined;
  try {
    const file = statSync(launcher);
    if (!file.isFile() || file.size > 4096) return undefined;
    const script = readFileSync(launcher, "utf8");
    const revision = /^MCODE_BUILD_ID=([0-9a-f]{40})$/m.exec(script)?.[1];
    const command = /^exec (\/[^\s'"]+\/node) (\/[^\s'"]+\/cli\.js) "\$@"$/m.exec(script);
    if (!revision || !command?.[1] || !command[2]) return undefined;
    const prefix = dirname(dirname(launcher));
    const release = join("installs", "ncode", revision, "lib", "node_modules", "@niwa-labs", "ncode");
    const pkg = dirname(command[2]);
    const installed = join(realpathSync(prefix), release);
    if (realpathSync(pkg) !== installed || realpathSync(command[2]) !== join(installed, "cli.js")) return undefined;
    const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const build = JSON.parse(readFileSync(join(pkg, "release.json"), "utf8"));
    if (metadata.name !== "@niwa-labs/ncode" || build.revision !== revision) return undefined;

    // A distribution's own bin/node and public development header identify its prefix. Never
    // grant that prefix: the executable and the one active release are the entire read grant.
    const runtime = realpathSync(command[1]);
    if (basename(runtime) !== "node" || basename(dirname(runtime)) !== "bin" || Bun.which(runtime) === null) return undefined;
    if (!existsSync(join(dirname(dirname(runtime)), "include", "node", "node_version.h"))) return undefined;
    return [...context.bin(pkg), ...context.bin(command[1])];
  } catch {
    return undefined;
  }
}

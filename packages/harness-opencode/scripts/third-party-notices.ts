import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly author?: string | { readonly name: string };
  readonly repository?: string | { readonly url: string };
}

interface BuildMetadata {
  readonly outputs: Readonly<Record<string, { readonly inputs: Readonly<Record<string, { readonly bytesInOutput: number }>> }>>;
}

const NOTICE = /^(?:licen[sc]es?|notices?|copying|copyright)(?:[._-]|$)/i;
const OPENCODE_LICENSE = new URL("../notices/opencode-2.3.2.LICENSE.txt", import.meta.url);
const FFF_LICENSE = new URL("../notices/fff-0.10.5.LICENSE.txt", import.meta.url);
const APACHE_LICENSE = new URL("../../cockpit/notices/apache-2.0.txt", import.meta.url);

/** The innermost node_modules identifies the dependency in hoisted and isolated Bun installs. */
function packageOf(file: string): string | undefined {
  const segments = file.split(sep);
  const parent = segments.lastIndexOf("node_modules");
  const name = segments[parent + 1];
  if (parent < 0 || name === undefined) return;
  return segments.slice(0, parent + (name.startsWith("@") ? 3 : 2)).join(sep);
}

function extraLicense(root: string, pkg: PackageManifest): string | undefined {
  if (pkg.name.startsWith("@opencode/") && pkg.version === "2.3.2") return `See the OpenCode project license below.`;
  if (pkg.name === "@ff-labs/fff-bun" && pkg.version === "0.10.5") return readFileSync(FFF_LICENSE, "utf8");
  if (pkg.license === "Apache-2.0") return `See the Apache License, Version 2.0 below.`;
  if (pkg.name === "spdx-exceptions" || pkg.name === "spdx-license-ids") return readFileSync(join(root, "README.md"), "utf8").split(/^## (?:Copyright and Licensing|License)$/m).at(-1)?.trim();
  if (pkg.name === "@npmcli/agent" && pkg.version === "4.0.2") return "The pinned upstream release declares the ISC license. https://spdx.org/licenses/ISC.html";
  return undefined;
}

/** Include the notices of packages whose code and assets Bun actually placed in the bundle. */
export function writeThirdPartyNotices(output: string, metafile: string, buildDirectory: string): void {
  const metadata = JSON.parse(readFileSync(metafile, "utf8")) as BuildMetadata;
  const roots = new Set<string>();
  for (const result of Object.values(metadata.outputs)) {
    for (const [file, info] of Object.entries(result.inputs)) {
      const root = packageOf(resolve(buildDirectory, file));
      if (info.bytesInOutput > 0 && root !== undefined) roots.add(root);
    }
  }
  if (roots.size === 0) throw new Error("Bun did not report dependencies for the boxed OpenCode runtime");
  const notices = new Map<string, string>();
  for (const root of roots) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
    const files = readdirSync(root, { withFileTypes: true }).filter((file) => file.isFile() && NOTICE.test(file.name));
    const body = files.map(({ name }) => `${name}\n\n${readFileSync(join(root, name), "utf8").trim()}`).join("\n\n");
    const license = body || extraLicense(root, pkg);
    if (license === undefined) throw new Error(`Missing license notice for bundled package ${pkg.name}@${pkg.version}`);
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    notices.set(`${pkg.name}@${pkg.version} (${pkg.license ?? "see license text"})`, [author, repository, license].filter(Boolean).join("\n\n"));
  }
  notices.set("OpenCode project license (v2.3.2)", readFileSync(OPENCODE_LICENSE, "utf8"));
  notices.set("Apache License, Version 2.0", readFileSync(APACHE_LICENSE, "utf8"));
  const sections = [...notices].sort(([a], [b]) => a.localeCompare(b, "en")).map(([title, notice]) => `${title}\n\n${notice.trim()}`);
  writeFileSync(join(output, "THIRD-PARTY-LICENSES.txt"), sections.join(`\n\n${"-".repeat(68)}\n\n`) + "\n");
}

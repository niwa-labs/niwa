import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Git, formatMapping, openMap, pathsIn, refreshUpstream, summaryOf, writeAssembled } from "../src/index.ts";
import type { SnapshotSpec } from "../src/index.ts";

function commit(git: Git): string {
  git.out(["add", "."]);
  git.out(["-c", "user.name=Upstream map test", "-c", "user.email=map@example.org", "commit", "-qm", "fixture"]);
  return git.out(["rev-parse", "HEAD"]).trim();
}

test("a code-only map refreshes a different tree and leaves unrelated JSON alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "upstream-map-test-"));
  try {
    const root = join(dir, "destination");
    const upstreamDir = join(dir, "vendor");
    const upstream = new Git(upstreamDir);
    const target = new Git(root);
    const paths = pathsIn(root);
    const filename = "révision.md";
    const spec: SnapshotSpec = {
      repository: "https://example.org/vendor",
      path: "rules",
      paths: [{ snapshot: "guides", from: "rules", keep: [filename, "diagram.bin"] }],
      metadata: ["guides/diagram.bin"],
      requiredFiles: [`guides/${filename}`],
    };
    const rule = "Perform the review.\n";
    const code = "export const review = true;\n";
    const bytes = Buffer.from([0, 255, 128, 10]);
    mkdirSync(join(upstreamDir, "rules"), { recursive: true });
    upstream.out(["init", "-q"]);
    writeFileSync(join(upstreamDir, "rules", filename), rule);
    writeFileSync(join(upstreamDir, "rules", "diagram.bin"), bytes);
    writeFileSync(join(upstreamDir, "rules", "unused.md"), "Omitted from the selection.\n");
    const upstreamCommit = commit(upstream);
    mkdirSync(paths.texts, { recursive: true });
    target.out(["init", "-q"]);
    writeFileSync(join(root, "review.ts"), code);
    const other = join(paths.texts, "metadata.json");
    writeFileSync(other, "{}\n");
    const targetCommit = commit(target);
    expect(refreshUpstream(upstreamDir, spec, paths)).toEqual({ repository: spec.repository, path: spec.path, commit: upstreamCommit });
    expect(readFileSync(join(paths.upstream, "guides", "diagram.bin"))).toEqual(bytes);
    const map = formatMapping({
      entries: [{
        id: "review",
        upstream: { commit: upstreamCommit, file: `guides/${filename}`, range: [0, rule.length] },
        ours: [{ commit: targetCommit, file: "review.ts", range: [0, code.length] }],
        kind: "code",
      }],
    });
    writeFileSync(paths.mapping, map);
    const context = { paths, snapshot: spec, root };
    expect(summaryOf(openMap(context).report)).toMatchObject({ coverage: 100, entries: 1, unchanged: 1, problems: 0, textProblems: 0 });
    expect(writeAssembled(context)).toBe(0);
    expect(readFileSync(other, "utf8")).toBe("{}\n");
    refreshUpstream(upstreamDir, spec, paths);
    expect(readFileSync(paths.mapping, "utf8")).toBe(map);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

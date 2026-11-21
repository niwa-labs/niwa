// A patch holding several files renders each of them.

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { DiffView } from "../src/index.ts";

const oneFile = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;

const otherFile = `diff --git a/b.txt b/b.txt
index 333..444 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
`;

function views(html: string): number {
  return html.match(/<diffs-container/g)?.length ?? 0;
}

describe("diff view", () => {
  test("a patch of two files renders a diff for each", () => {
    const html = renderToString(<DiffView patch={oneFile + otherFile} />);
    expect(views(html)).toBe(2);
  });

  test("a patch of one file renders it", () => {
    expect(views(renderToString(<DiffView patch={oneFile} />))).toBe(1);
  });

  test("an empty patch renders nothing", () => {
    expect(renderToString(<DiffView patch="" />)).toBe("");
  });

  test("two versions of a file render one diff", () => {
    const html = renderToString(
      <DiffView before={{ name: "a.txt", contents: "one\n" }} after={{ name: "a.txt", contents: "two\n" }} />,
    );
    expect(views(html)).toBe(1);
  });
});

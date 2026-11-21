import {expect, test} from "bun:test";
import {mkdirSync, realpathSync, renameSync} from "node:fs";
import {join} from "node:path";
import {tempHome} from "@niwa-labs/testing";
import {recordId, seq, timestamp} from "@niwa-labs/core";
import type {JournalReader, StoredRecord} from "@niwa-labs/core";
import type {PluginApi} from "@niwa-labs/plugin";
import {registeredWorktree, verifyCheckout} from "../src/registration.ts";
import {CheckoutVerified, WorktreeCreated, WorktreeRemoved, WorktreeId} from "../src/record-types.ts";

test("the registration requires a host receipt, a matching creation, unchanged directories and no removal", async () => {
  const home = await tempHome();
  try {
    const dir = realpathSync(home.path);
    const id = WorktreeId.parse("wt-aaa111");
    const path = join(dir, "worktrees", id);
    const repo = join(dir, "repo");
    const common = join(repo, ".git");
    mkdirSync(join(common, "worktrees", id), {recursive: true});
    mkdirSync(join(path, "src"), {recursive: true});
    const rows: StoredRecord[] = [];
    const reader = {
      get: (record: string) => rows.find(row => row.id === record),
      find: ({type, equals}: {type: string; equals: string}) => rows.filter(row => row.type === type && (row.data as {id: string}).id === equals),
    } as JournalReader;
    const api = {
      home: () => dir, journal: () => reader,
      emit: (type: typeof CheckoutVerified, data: unknown, opts: {id: string}) => {
        rows.push({id: recordId(opts.id), data, type: type.name, actor: {kind: "host"}, seq: seq(1), at: timestamp(0)} as StoredRecord);
      },
    } as PluginApi;
    const tree = {id, path, repo, description: "fixture", base: "main", baseSha: "a".repeat(40), branch: id};
    const lookup = () => registeredWorktree(api, join(path, "src"));
    expect(lookup()).toBeUndefined();
    await verifyCheckout(api, tree, "creation");
    expect(lookup()).toBeUndefined();
    const [receipt] = rows;
    if (!receipt) throw new Error("missing fixture receipt");
    rows.push({...receipt, id: recordId("creation"), seq: seq(2), type: WorktreeCreated.name, data: tree});
    expect(lookup()).toEqual({id, repo, path});

    rows[0] = {...receipt, actor: {kind: "client", id: "fixture" as never}};
    expect(lookup()).toBeUndefined();
    rows[0] = {...receipt, actor: {kind: "handler", handler: "test/a" as never, invocation: "fixture" as never}};
    expect(lookup()).toBeUndefined();
    rows[0] = receipt;
    renameSync(common, join(repo, "old"));
    mkdirSync(join(common, "worktrees", id), {recursive: true});
    expect(lookup()).toBeUndefined();
    renameSync(common, join(repo, "other"));
    renameSync(join(repo, "old"), common);
    expect(lookup()).toBeDefined();
    rows.push({...receipt, id: recordId("removal"), seq: seq(3), type: WorktreeRemoved.name, data: {id, forced: false}});
    expect(lookup()).toBeUndefined();
  } finally { await home.cleanup(); }
});

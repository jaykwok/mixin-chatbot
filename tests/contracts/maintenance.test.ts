import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ContractError, decodeArchivePlan, decodeArchiveProgress, decodeLegacyJournal, decodePlanSummary, decodeProgressSummary, decodeReclaimPlan,
  decodeReclaimProgress, decodeRemovalPlan, decodeRemovalProgress, decodeWindowsJournal, journalRecordsDeletion, planDigest, type TreeEvidence,
} from "../../src/contracts/maintenance.ts";

type Doc = Record<string, any>;
const root = resolve("/srv/mixin/data"), archive = join(root, "state", "reclamation", "backup", "rm");
const id = "11111111-2222-4333-8444-555555555555", other = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const evidence: TreeEvidence = { dev: "2049", ino: "131074", uid: 1000, fingerprint: "a".repeat(64), bytes: 5, files: 1, newest: 1 };
const member = join(root, "tmp", "groups", "g", "u");

/** A saved document: every field but the digest, then the digest over them in this order. */
const sealed = (value: Doc): Doc => ({ ...value, digest: planDigest(value) });
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error as Error; } throw new Error("decoded"); };
/** Each case edits a valid document (and re-digests it), so only the named rule can fail. */
function rejects(make: (edit?: (value: Doc) => void) => Doc, decode: (value: Doc) => unknown, message: string,
  cases: [field: string, edit: (value: Doc) => void][]) {
  for (const [field, edit] of cases) {
    const error = failure(() => decode(make(edit)));
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toBe(`${message}：${field}`);
  }
}

describe("archive plans", () => {
  const plan = (edit?: (value: Doc) => void) => {
    const value: Doc = { version: 1, id, root, rootIdentity: "2049:1", archive, recordedRoot: root, createdAt: 1, before: 2, items: [
      { space: "groups/g", user: "u", source: join(member, "a"), destination: join(archive, `tmp-${id}-0`), owners: { "1-r.txt": { phone: "u", createdAt: 1 } },
        task: other, status: "ready", evidence },
      { space: "groups/g", user: "u", source: member, destination: join(archive, `tmp-${id}-1`), owners: {}, status: "deferred", reason: "x" },
    ] };
    edit?.(value);
    return sealed(value);
  };
  const view = { id, root, archive };
  const decode = (value: Doc) => decodeArchivePlan(value, { ...view, digest: value.digest });

  test("a saved plan decodes unchanged; digest, version and key order are binding", () => {
    const saved = plan();
    expect(decode(saved)).toBe(saved as never);
    expect(decodeArchivePlan(saved, { ...view, digest: saved.digest, recordedRoot: root }).id).toBe(id);
    const { digest, ...fields } = saved;
    const reordered = { items: fields.items, ...fields, digest };
    expect(failure(() => decode(reordered)).message).toBe("归档清单、摘要或实体已变化：digest");
    expect(failure(() => decode({ ...saved, before: 3 })).message).toBe("归档清单、摘要或实体已变化：digest");
    expect(failure(() => decodeArchivePlan(saved, { ...view, digest: "b".repeat(64) })).message).toBe("归档清单、摘要或实体已变化：digest");
    expect(failure(() => decodeArchivePlan(saved, { ...view, digest: saved.digest, recordedRoot: "/other" })).message).toBe("归档清单、摘要或实体已变化：recordedRoot");
    expect(failure(() => decodeArchivePlan(null, { ...view, digest: saved.digest })).message).toBe("归档清单、摘要或实体已变化：清单");
  });

  test("each rule names its field", () => rejects(plan, decode, "归档清单、摘要或实体已变化", [
    ["version", value => { value.version = 2; }],
    ["id", value => { value.id = other; }],
    ["root", value => { value.root = join(root, "x"); }],
    ["archive", value => { value.archive = join(root, "rm"); }],
    ["items", value => { value.items = {}; }],
    ["before", value => { value.before = null; }],
    ["items[0]", value => { value.items[0] = []; }],
    ["items[0].space/user", value => { value.items[0].space = "groups/../g"; }],
    ["items[0].space/user", value => { value.items[0].user = ["u"]; }],
    ["items[0].source", value => { value.items[0].source = join(root, "tmp", "groups", "g", "v", "a"); }],
    ["items[0].source", value => { value.items[0].source = member + "/./a"; }],
    ["items[1].source（成员 tmp 本身不能归档）", value => { value.items[1].status = "ready"; }],
    ["items[0].destination", value => { value.items[0].destination = join(archive, `tmp-${id}-1`); }],
    ["items[0].status", value => { value.items[0].status = "archived"; }],
    ["items[0].evidence", value => { value.items[0].evidence = { ...evidence, bytes: -1 }; }],
    ["items[0].task", value => { value.items[0].task = "task"; }],
    ["items[0].owners", value => { value.items[0].owners = []; }],
    ["items[0].owners.bad", value => { value.items[0].owners = { bad: { phone: "u", createdAt: 1 } }; }],
    ["items[0].owners.1-r.txt", value => { value.items[0].owners["1-r.txt"].isolatedTask = "x"; }],
    ["items[0].owners.1-r.txt", value => { value.items[0].owners["1-r.txt"].createdAt = "1"; }],
  ]));

  test("progress: numeric starts; archived only after its start was saved", () => {
    const saved = decode(plan()), progress = (edit?: (value: Doc) => void) => {
      const value: Doc = { version: 1, digest: saved.digest, started: [0], outcomes: { 0: { status: "archived", bytes: 5 }, 1: { status: "deferred", bytes: 0, reason: "x" } } };
      edit?.(value);
      return value;
    };
    expect(decodeArchiveProgress(progress(), saved).outcomes["0"]!.status).toBe("archived");
    rejects(progress, value => decodeArchiveProgress(value, saved), "归档进度与清单不符", [
      ["version", value => { value.version = 2; }],
      ["digest", value => { value.digest = "b".repeat(64); }],
      ["started", value => { value.started = ["0"]; }],
      ["started", value => { value.started = [2]; }],
      ["outcomes", value => { value.outcomes = []; }],
      ["outcomes.01", value => { value.outcomes = { "01": { status: "kept", bytes: 0 } }; }],
      ["outcomes.2", value => { value.outcomes = { 2: { status: "kept", bytes: 0 } }; }],
      ["outcomes.1", value => { value.outcomes[1].status = "removed"; }],
      ["outcomes.1", value => { value.outcomes[1].bytes = -1; }],
      ["outcomes.0（未记录开始）", value => { value.started = []; }],
    ]);
  });
});

describe("removal lists", () => {
  const removal = (edit?: (value: Doc) => void) => {
    const value: Doc = { version: 1, id, archive, archiveIdentity: "2049:9", createdAt: 1, items: [
      { plan: other, planDigest: "c".repeat(64), index: 3, destination: join(archive, `tmp-${other}-3`), evidence, kind: "directory", status: "ready" },
    ], skipped: [{ plan: id, reason: "x" }] };
    edit?.(value);
    return sealed(value);
  };
  const decode = (value: Doc) => decodeRemovalPlan(value, { id, digest: value.digest, archive });

  test("rules", () => {
    expect(decode(removal()).items[0]!.kind).toBe("directory");
    rejects(removal, decode, "删除清单、摘要或归档根已变化", [
      ["archive", value => { value.archive = root; }],
      ["items[0].plan", value => { value.items[0].planDigest = "C".repeat(64); }],
      ["items[0].index", value => { value.items[0].index = -1; }],
      ["items[0].destination", value => { value.items[0].destination = join(archive, `tmp-${other}-4`); }],
      ["items[0].evidence", value => { delete value.items[0].evidence; }],
      ["items[0].kind", value => { value.items[0].kind = "socket"; }],
      ["items[0].task", value => { value.items[0].task = 1; }],
    ]);
  });

  test("progress allows missing; removed needs a saved start", () => {
    const saved = decode(removal()), progress = (edit?: (value: Doc) => void) => {
      const value: Doc = { version: 1, digest: saved.digest, started: [0], outcomes: { 0: { status: "missing", bytes: 0, reason: "x" } } };
      edit?.(value);
      return value;
    };
    expect(decodeRemovalProgress(progress(), saved).outcomes["0"]!.status).toBe("missing");
    expect(decodeRemovalProgress(progress(value => { value.outcomes[0] = { status: "removed", bytes: 0, finishing: true }; }), saved).outcomes["0"]!.finishing).toBe(true);
    rejects(progress, value => decodeRemovalProgress(value, saved), "删除进度与清单不符", [
      ["outcomes.0", value => { value.outcomes[0].status = "archived"; }],
      ["outcomes.0（未记录开始）", value => { value.outcomes[0].status = "removed"; value.started = []; }],
      // Finishing: only on a removed outcome, with no bytes.
      ["outcomes.0", value => { value.outcomes[0].finishing = true; }],
      ["outcomes.0", value => { value.outcomes[0] = { status: "removed", bytes: 3, finishing: true }; }],
    ]);
  });
});

describe("physical reclamation plans", () => {
  const plan = (edit?: (value: Doc) => void) => {
    const value: Doc = { version: 1, id, root, recordedRoot: "/srv/recorded", rootIdentity: "2049:1", legacy: true, createdAt: 1, before: 2, items: [
      { space: "groups/g", user: "u", path: join(member, "codemode", "1-r.txt"), result: "1-r.txt", owner: { phone: "u", createdAt: 1 }, token: "t", evidence, status: "ready" },
      { space: "groups/g", user: "u", path: member, task: other, status: "deferred", reason: "x" },
    ] };
    edit?.(value);
    return sealed(value);
  };
  const view = { id, root, recordedRoot: "/srv/recorded", legacy: true };
  const decode = (value: Doc) => decodeReclaimPlan(value, { ...view, digest: value.digest });

  test("rules", () => {
    expect(decode(plan()).items).toHaveLength(2);
    expect(failure(() => decodeReclaimPlan(plan(), { ...view, digest: plan().digest, legacy: false })).message).toBe("回收清单、摘要或数据目录实体已变化，拒绝执行：legacy");
    rejects(plan, decode, "回收清单、摘要或数据目录实体已变化，拒绝执行", [
      ["recordedRoot", value => { value.recordedRoot = root; }],
      ["items[0].path", value => { value.items[0].path = "relative"; }],
      ["items[1].task", value => { value.items[1].task = "x"; }],
      ["items[0].evidence", value => { value.items[0].evidence = { ...evidence, files: 100_001 }; }],
    ]);
  });

  test("progress names the plan and keeps string starts", () => {
    const saved = decode(plan()), progress = (edit?: (value: Doc) => void) => {
      const value: Doc = { version: 1, plan: saved.digest, outcomes: { 0: { status: "removed", bytes: 5 } }, started: ["0"] };
      edit?.(value);
      return value;
    };
    expect(decodeReclaimProgress(progress(), saved).started).toEqual(["0"]);
    rejects(progress, value => decodeReclaimProgress(value, saved), "回收进度与清单不匹配", [
      ["plan", value => { value.plan = "b".repeat(64); }],
      ["started", value => { value.started = [0]; }],
      ["outcomes.0", value => { value.outcomes[0].status = "missing"; }],
      ["outcomes.0（未记录开始）", value => { value.started = []; }],
      ["outcomes.0", value => { value.outcomes[0].finishing = true; }],
    ]);
    expect(decodeReclaimProgress(progress(value => { value.outcomes[0] = { status: "removed", bytes: 0, finishing: true }; }), saved).outcomes["0"]!.finishing).toBe(true);
  });
});

describe("platform journals", () => {
  test("Linux journal v1 fixture decodes; directory rules", async () => {
    const saved = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/maintenance-formats/legacy-journal.v1.json"), "utf8"));
    const decode = (value: Doc) => decodeLegacyJournal(value, saved.path, saved.parent, saved.proof);
    expect(decode(saved).directories.map(entry => entry.relative)).toEqual(["..", "", "inner"]);
    const journal = (edit?: (value: Doc) => void) => { const value = structuredClone(saved); edit?.(value); return value; };
    rejects(journal, decode, "旧目录回收事务与清单不匹配", [
      ["parent", value => { value.parent = "/srv"; }],
      ["proof", value => { value.proof = { ...value.proof, bytes: 6 }; }],
      ["phase", value => { value.phase = "unknown"; }],
      ["directories", value => { value.directories = []; }],
      ["directories[0].relative", value => { value.directories[0].relative = ""; }],
      ["directories[2].relative", value => { value.directories[2].relative = "a/../b"; }],
      ["directories[2].relative", value => { value.directories[2].relative = "a\\b"; }],
      ["directories[2].uid", value => { value.directories[2].uid = 0; }],
      ["directories[2].mode", value => { value.directories[2].mode = 0o10000; }],
      ["directories（路径重复）", value => { value.directories[2].relative = ""; }],
    ]);
    // The parent keeps its own owner (index 0 is not the old writer's).
    expect(decode(journal(value => { value.directories[0].uid = 0; })).directories[0]!.uid).toBe(0);
  });

  test("Windows journal rules", () => {
    const path = join(member, "a");
    const journal = (edit?: (value: Doc) => void) => {
      const value: Doc = { version: 1, path, proof: evidence, phase: "deleting", entries: [
        { path: "", dev: "1", ino: "2", attributes: 16 }, { path: "x", dev: "1", ino: "3", attributes: 32 }] };
      edit?.(value);
      return value;
    };
    const decode = (value: Doc) => decodeWindowsJournal(value, path, evidence);
    expect(decode(journal()).entries).toHaveLength(2);
    rejects(journal, decode, "Windows 回收事务与清单不符", [
      ["path", value => { value.path = member; }],
      ["phase", value => { value.phase = "restored"; }],
      ["entries", value => { value.entries = []; }],
      ["entries[]", value => { value.entries[1].ino = 3; }],
      ["entries[]", value => { value.entries[1].attributes = 1.5; }],
      ["entries[0].path", value => { value.entries.reverse(); }],
      ["entries（路径重复）", value => { value.entries[1].path = ""; }],
    ]);
  });

  test("only a matching deleting/removed/restored journal records a deletion intent", () => {
    const path = join(member, "a"), journal = { version: 1, path, proof: evidence, phase: "deleting" };
    expect(journalRecordsDeletion(journal, path, evidence)).toBe(true);
    expect(journalRecordsDeletion({ ...journal, phase: "restored" }, path, evidence)).toBe(true);
    expect(journalRecordsDeletion({ ...journal, phase: "fencing" }, path, evidence)).toBe(false);
    expect(journalRecordsDeletion(journal, path, { ...evidence, newest: 2 })).toBe(false);
    expect(journalRecordsDeletion(null, path, evidence)).toBe(false);
  });
});

describe("host summaries", () => {
  test("any plan kind; progress by digest or plan", () => {
    const plan = sealed({ version: 1, id, items: [{ status: "ready", evidence: { bytes: 7 } }, { status: "kept" }, { status: "deferred" }] });
    expect(decodePlanSummary(plan, id)).toEqual({ id, digest: plan.digest, ready: 1, bytes: 7, kept: 1, deferred: 1 });
    expect(failure(() => decodePlanSummary({ ...plan, items: [] }, id)).message).toBe("清单摘要或条目无效：digest");
    expect(failure(() => decodePlanSummary(sealed({ version: 1, id, items: [{ status: "ready", evidence: null }] }), id)).message)
      .toBe("清单摘要或条目无效：items[0].evidence");
    const outcomes = { 0: { status: "removed", bytes: 7 }, 1: { status: "missing", bytes: 0 }, 2: { status: "removed", bytes: 0, finishing: true } };
    // A finishing outcome is counted on its own, never as a removal of this list.
    expect(decodeProgressSummary({ version: 1, plan: plan.digest, outcomes }, plan.digest, "removed"))
      .toEqual({ done: 1, bytes: 7, finishing: 1, kept: 0, deferred: 0, failed: 0, missing: 1 });
    for (const bad of [{ status: "removed", bytes: 5, finishing: true }, { status: "deferred", bytes: 0, finishing: true }, { status: "removed", bytes: 0, finishing: 1 }]) {
      expect(failure(() => decodeProgressSummary({ version: 1, plan: plan.digest, outcomes: { 0: bad } }, plan.digest, "removed")).message).toBe("清单结果无效");
    }
    expect(failure(() => decodeProgressSummary({ version: 1, digest: "b".repeat(64), outcomes }, plan.digest, "removed")).message).toBe("结果与清单不符");
    expect(failure(() => decodeProgressSummary({ version: 1, digest: plan.digest, outcomes }, plan.digest, "archived")).message).toBe("清单结果无效");
  });
});

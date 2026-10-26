import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInside } from "../../src/contracts/paths.ts";
import {
  appLayout, checkWorkspace, DIRECT_SCOPE, groupScope, groupSegment, parseScopeKey, requestSegment, requestTmp, scopeKey,
  scopeLabel, spaceDatabase, statsSegment, userSegment, userTmp,
} from "../../src/core/layout.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("layout-");
afterAll(() => fixture.cleanup());

describe("segments", () => {
  test("keeps safe group and user ids readable", () => {
    expect(groupSegment("group_123-abc")).toBe("group_123-abc");
    expect(userSegment("+8613800000000")).toBe("+8613800000000");
  });

  test("hashes unsafe and Windows-reserved ids", () => {
    expect(groupSegment("群聊/研发")).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(groupSegment("CON")).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(userSegment("NUL")).toMatch(/^sha256-user-[0-9a-f]{64}$/);
  });

  test("maps a request id to one directory name and refuses anything else", () => {
    const id = "msg:01234567-89ab-cdef-0123-456789abcdef";
    expect(requestSegment(id)).toBe("msg-01234567-89ab-cdef-0123-456789abcdef");
    expect(() => requestSegment("msg:../x")).toThrow("请求标识格式不符");
  });
});

describe("scopes", () => {
  test("keys, labels and statistics segments keep the direct space apart from every group", () => {
    expect(scopeKey(DIRECT_SCOPE)).toBe("direct");
    expect(scopeKey(groupScope("direct"))).toBe("group:direct");
    expect(parseScopeKey("direct")).toEqual(DIRECT_SCOPE);
    expect(parseScopeKey("group:100")).toEqual(groupScope("100"));
    expect(parseScopeKey("group:")).toBeUndefined();
    expect(parseScopeKey("100")).toBeUndefined();
    expect(scopeLabel(DIRECT_SCOPE)).toBe("单聊");
    expect(scopeLabel(groupScope("100"))).toBe("群 100");
    expect(statsSegment(DIRECT_SCOPE)).toBe("direct");
    expect(statsSegment(groupScope("100"))).toBe("100");
    expect(() => groupScope("")).toThrow("群号为空");
  });
});

describe("app layout", () => {
  test("one data directory: shared workspace, per-space databases, per-member tmp", () => {
    const data = join("deploy", "data");
    const layout = appLayout(data);
    expect(layout.workspace).toBe(join(data, "workspace"));
    expect(layout.externalWorkspace).toBe(false);
    expect(layout.stats).toBe(join(data, "state", "stats.sqlite"));
    expect(layout.materialsIndex).toBe(join(data, "index", "materials.md"));
    expect(spaceDatabase(layout, DIRECT_SCOPE)).toBe(join(data, "conversations", "direct", "durable.sqlite"));
    expect(spaceDatabase(layout, groupScope("100"))).toBe(join(data, "conversations", "groups", "100", "durable.sqlite"));
    const alice = userTmp(layout, groupScope("100"), "+8613800000000");
    expect(alice).toBe(join(data, "tmp", "groups", "100", "+8613800000000"));
    expect(userTmp(layout, DIRECT_SCOPE, "+8613800000000")).toBe(join(data, "tmp", "direct", "+8613800000000"));
    expect(userTmp(layout, groupScope("100"), "+8613900000000")).not.toBe(alice);
    expect(requestTmp(alice, "msg:01234567-89ab-cdef-0123-456789abcdef"))
      .toBe(join(alice, "tasks", "msg-01234567-89ab-cdef-0123-456789abcdef"));
    expect(isPathInside(alice, layout.workspace)).toBe(false);
  });

  test("WORKSPACE_ROOT replaces the shared workspace; blank keeps the default", () => {
    const data = join("deploy", "data");
    expect(appLayout(data, "  ").workspace).toBe(join(data, "workspace"));
    const external = appLayout(data, join("mnt", "materials"));
    expect(external.workspace).toBe(resolve("mnt", "materials"));
    expect(external.externalWorkspace).toBe(true);
    expect(appLayout(data, join(data, "workspace")).externalWorkspace).toBe(false);
  });

  test("the workspace check refuses a missing mount, a file, a workspace holding the data, and one inside managed state", () => {
    const project = join(fixture.root, "project");
    const data = join(project, "data");
    mkdirSync(join(data, "workspace"), { recursive: true });
    checkWorkspace(appLayout(data), project);
    expect(() => checkWorkspace(appLayout(data, join(fixture.root, "missing")), project)).toThrow("WORKSPACE_ROOT 不存在");
    writeFileSync(join(fixture.root, "file"), "");
    expect(() => checkWorkspace(appLayout(data, join(fixture.root, "file")), project)).toThrow("资料目录不是目录");
    expect(() => checkWorkspace(appLayout(data, project), project)).toThrow("包含数据目录");
    mkdirSync(join(data, "tmp", "x"), { recursive: true });
    expect(() => checkWorkspace(appLayout(data, join(data, "tmp", "x")), project)).toThrow("位于受管目录");
    mkdirSync(join(project, "backup", "x"), { recursive: true });
    expect(() => checkWorkspace(appLayout(data, join(project, "backup", "x")), project)).toThrow("位于受管目录");
    const outside = join(fixture.root, "materials");
    mkdirSync(outside);
    checkWorkspace(appLayout(data, outside), project);
  });

  test("a managed directory linked into the workspace is refused, while data itself stays outside", () => {
    for (const managed of ["data/config", "data/state", "data/conversations", "data/tmp", "data/index", "data/runtime", "backup", "logs"]) {
      const root = join(fixture.root, `reverse-${managed.replace("/", "-")}`), project = join(root, "project"), data = join(project, "data");
      const workspace = join(root, "materials"), hidden = join(workspace, "private");
      mkdirSync(data, { recursive: true });
      mkdirSync(hidden, { recursive: true });
      symlinkSync(hidden, join(project, managed), "junction");
      expect(() => checkWorkspace(appLayout(data, workspace), project), managed).toThrow("实际位于资料目录");
      // The same link outside the workspace is fine; the default data/workspace stays allowed.
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      checkWorkspace(appLayout(data, elsewhere), project);
    }
    const project = join(fixture.root, "reverse-default", "project"), data = join(project, "data");
    mkdirSync(join(data, "workspace"), { recursive: true });
    checkWorkspace(appLayout(data), project);
  });
});

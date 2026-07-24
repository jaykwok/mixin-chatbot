import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  groupSegment,
  groupWorkspaceDir,
  isPathInside,
  sessionFilePath,
  userSegment,
  userTempDir,
} from "../../src/agent/paths.ts";

describe("group-first agent paths", () => {
  test("uses readable safe group ids", () => {
    expect(groupSegment("group_123-abc")).toBe("group_123-abc");
  });

  test("hashes unsafe and Windows-reserved group ids", () => {
    expect(groupSegment("群聊/研发")).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(groupSegment("CON")).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  test("keeps normal callers readable and hashes Windows device names", () => {
    expect(userSegment("+8613800000000")).toBe("+8613800000000");
    expect(userSegment("NUL")).toMatch(/^sha256-user-[0-9a-f]{64}$/);
  });

  test("puts shared work at group level and scratch/history under the user", () => {
    const root = "data";
    const groupId = "group-a";
    const phone = "+8613800000000";

    expect(groupWorkspaceDir(root, groupId)).toBe(join(root, groupId, "workspace"));
    expect(userTempDir(root, groupId, phone)).toBe(
      join(root, groupId, phone, "tmp")
    );
    expect(sessionFilePath(root, groupId, phone)).toBe(
      join(root, groupId, phone, "sessions", "session.jsonl")
    );
    expect(userTempDir(root, groupId, "+8613900000000")).not.toBe(
      userTempDir(root, groupId, phone)
    );
    expect(sessionFilePath(root, groupId, "+8613900000000")).not.toBe(
      sessionFilePath(root, groupId, phone)
    );
  });

  test("recognizes only paths inside an allowed root", () => {
    const root = join("data", "group-a", "workspace");
    expect(isPathInside(join(root, "result.md"), root)).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(
      isPathInside(join(root, "..", "+8613800000000", "tmp", "draft.md"), root)
    ).toBe(false);
  });
});

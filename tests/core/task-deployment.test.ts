import { expect, test } from "bun:test";
import { TaskPaths, type TaskDeployment } from "../../src/core/task-deployment.ts";

const image = "sha256:" + "a".repeat(64);
function manifest(): TaskDeployment {
  return { version: 1, image, mounts: [{ manager: "/app/data", daemon: "/srv/bot/data" }, { manager: "/app/groups", daemon: "/srv/groups" }],
    imagePaths: ["/app/scripts/runtime", "/app/src/agent/modules/document-work", "/usr/local/bin/bun"] };
}

test("task deployment translates only registered roots and preserves worker-visible paths", () => {
  const paths = new TaskPaths(manifest(), image);
  expect(paths.source("/app/data/groups/member/.isolated-work/id/work")).toBe("/srv/bot/data/groups/member/.isolated-work/id/work");
  expect(paths.source("/app/groups")).toBe("/srv/groups");
  for (const path of ["/app/database", "/app", "/unregistered", "/app/data/../secret", "/app/data//member", "/app/data/"]) {
    expect(() => paths.source(path)).toThrow();
  }
  expect(paths.suppliedByImage("/app/scripts/runtime/extract_document.py")).toBe(true);
  expect(paths.suppliedByImage("/usr/local/bin/bun")).toBe(true);
  expect(paths.suppliedByImage("/app/scripts/runtime-other")).toBe(false);
  expect(() => paths.source("/usr/local/bin/bun")).toThrow();
});

test("task deployment identity is stable across ordering and owns its input snapshot", () => {
  const input = manifest(), paths = new TaskPaths(input, image);
  const reordered = { ...input, mounts: [...input.mounts].reverse(), imagePaths: [...input.imagePaths].reverse() };
  expect(new TaskPaths(reordered, image).identity).toBe(paths.identity);
  input.mounts[0]!.daemon = "/elsewhere";
  expect(paths.source("/app/data/owned")).toBe("/srv/bot/data/owned");
  expect(new TaskPaths(input, image).identity).not.toBe(paths.identity);
  expect(new TaskPaths({ ...manifest(), imagePaths: [] }, image).identity).not.toBe(paths.identity);
  const upgradedImage = "sha256:" + "b".repeat(64);
  expect(new TaskPaths({ ...manifest(), image: upgradedImage }, upgradedImage).identity).toBe(paths.identity);
});

test("task deployment refuses ambiguous roots, unsafe paths and mismatched images", () => {
  for (const mounts of [
    [{ manager: "/", daemon: "/srv" }],
    [{ manager: "/app/data", daemon: "/" }],
    [{ manager: "/app/data", daemon: "/srv,readonly" }],
    [{ manager: "/app/data\n", daemon: "/srv" }],
    [{ manager: "/app/data", daemon: "/srv/../elsewhere" }],
    [{ manager: "/app/data", daemon: "/srv/a" }, { manager: "/app/data/sub", daemon: "/srv/b" }],
    [{ manager: "/app/a", daemon: "/srv" }, { manager: "/app/b", daemon: "/srv/sub" }],
  ]) expect(() => new TaskPaths({ ...manifest(), mounts }, image)).toThrow();
  for (const imagePaths of [["/app"], ["/app/data/sub"], ["/image", "/image/sub"], ["/image", "/image"]]) {
    expect(() => new TaskPaths({ ...manifest(), imagePaths }, image)).toThrow();
  }
  expect(() => new TaskPaths({ ...manifest(), image: "sha256:" + "b".repeat(64) }, image)).toThrow();
  expect(() => new TaskPaths({ ...manifest(), mounts: [] }, image)).toThrow();
});

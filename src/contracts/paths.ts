import { isAbsolute, relative } from "node:path";

/** Lexical containment: `path` is `root` itself or below it. Links are the caller's concern. */
export function isPathInside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return !(
    fromRoot === ".." ||
    fromRoot.startsWith(`..\\`) ||
    fromRoot.startsWith("../") ||
    isAbsolute(fromRoot)
  );
}

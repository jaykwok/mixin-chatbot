/** Text that may still name a path (persisted contexts, pending deliveries), normalized by the caller.
 * Every lookup answers exactly like `text.includes(path)`. The text is located once per directory anchor,
 * so checking many paths of many members does not rescan the whole group context for each path. */
export class ReferenceText {
  readonly #source: () => string;
  #text?: string;
  readonly #anchors = new Map<string, number[]>();
  readonly #directories = new Map<string, string[]>();

  /** `source` runs at most once, on the first lookup: a pass with nothing to check never serializes the context. */
  constructor(source: () => string, readonly separator: string) {
    this.#source = source;
  }

  get #value(): string {
    return this.#text ??= this.#source();
  }

  /** `path` is searched verbatim; paths below the same `directory` (ending with the separator) share one scan. */
  includes(path: string, directory: string): boolean {
    const name = path.slice(directory.length);
    if (!directory.endsWith(this.separator) || !path.startsWith(directory) || name.length > FOLLOWING) return this.#value.includes(path);
    const following = this.#following(directory);
    let low = 0, high = following.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (following[middle]! < name) low = middle + 1; else high = middle;
    }
    return low < following.length && following[low]!.startsWith(name);
  }

  /** Sorted text after each occurrence of `directory`; a name occurs below it iff some entry starts with the name. */
  #following(directory: string): string[] {
    let following = this.#directories.get(directory);
    if (following) return following;
    // The last segment (e.g. `/codemode/`) is shared by all members: locate it once, then filter by the full prefix.
    const cut = directory.lastIndexOf(this.separator, directory.length - this.separator.length - 1);
    const anchor = cut < 0 ? directory : directory.slice(cut);
    let positions = this.#anchors.get(anchor);
    if (!positions) {
      positions = [];
      for (let at = this.#value.indexOf(anchor); at >= 0; at = this.#value.indexOf(anchor, at + 1)) positions.push(at);
      this.#anchors.set(anchor, positions);
    }
    following = [];
    for (const at of positions) {
      const end = at + anchor.length, start = end - directory.length;
      if (start >= 0 && this.#value.startsWith(directory, start)) following.push(this.#value.slice(end, end + FOLLOWING));
    }
    following.sort();
    this.#directories.set(directory, following);
    return following;
  }
}

/** Longer names fall back to a direct search; result and task names are far shorter. */
const FOLLOWING = 512;

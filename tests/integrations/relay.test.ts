import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../../src/core/config.ts";
import {
  loadRelayConfig,
  relayFile,
  type RelayConfig,
} from "../../src/integrations/relay.ts";
import {
  hashFile,
  openRelayIndex,
  relayCacheKey,
  type RelayIndex,
} from "../../src/integrations/relay-index.ts";

const VALID = {
  webdavUrl: "http://127.0.0.1:5244/dav/relay/",
  publicBaseUrl: "https://files.example.com/d/relay/",
  username: "bot",
  password: "secret",
};

const CONFIG: RelayConfig = { ...VALID, maxBytes: 1024 * 1024 };

async function withConfigFile<T>(
  contents: string,
  run: (path: string) => Promise<T> | T
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-relay-cfg-"));
  const path = join(root, "relay.json");
  await writeFile(path, contents, "utf8");
  try {
    return await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface Fixture {
  file: string;
  index: RelayIndex;
  indexPath: string;
}

/** 每个用例一份独立的临时文件 + 去重索引，避免互相污染。 */
async function withFixture<T>(
  run: (fixture: Fixture) => Promise<T>,
  contents = "hello"
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-relay-"));
  const file = join(root, "note.txt");
  const indexPath = join(root, "relay-index.jsonl");
  await writeFile(file, contents, "utf8");
  const index = await openRelayIndex(indexPath);
  try {
    return await run({ file, index, indexPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mockFetch(
  handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(input, init)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("relay config", () => {
  test("a missing file disables the feature instead of failing", () => {
    expect(loadRelayConfig(join(tmpdir(), "definitely-absent-relay.json"))).toBeNull();
  });

  test("accepts a complete config and defaults maxBytes", async () => {
    const config = await withConfigFile(JSON.stringify(VALID), (path) =>
      loadRelayConfig(path)
    );
    expect(config?.webdavUrl).toBe(VALID.webdavUrl);
    expect(config?.publicBaseUrl).toBe(VALID.publicBaseUrl);
    expect(config?.username).toBe("bot");
    expect(config?.maxBytes).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
  });

  // A present-but-broken config must fail loudly at startup: the alternative is
  // discovering the typo when a user finally sends a 100MB file.
  test("rejects malformed configs rather than silently disabling", async () => {
    const cases: [string, string][] = [
      ["not json at all", "有效 JSON"],
      [JSON.stringify([VALID]), "JSON 对象"],
      [JSON.stringify({ ...VALID, webdavUrl: "ftp://host/dav" }), "http://"],
      [JSON.stringify({ ...VALID, publicBaseUrl: "" }), "非空字符串"],
      [JSON.stringify({ ...VALID, maxBytes: -1 }), "正整数"],
      // 小于等于 IM 直传上限时外链永远不会触发，几乎必然是写错了。
      [JSON.stringify({ ...VALID, maxBytes: MAX_ATTACHMENT_BYTES }), "永远不会生效"],
      [
        JSON.stringify({
          webdavUrl: VALID.webdavUrl,
          publicBaseUrl: VALID.publicBaseUrl,
          username: "bot",
        }),
        "同时提供",
      ],
    ];
    for (const [contents, expected] of cases) {
      await withConfigFile(contents, (path) => {
        expect(() => loadRelayConfig(path)).toThrow(expected);
      });
    }
  });

  test("allows omitting credentials entirely", async () => {
    const config = await withConfigFile(
      JSON.stringify({ webdavUrl: VALID.webdavUrl, publicBaseUrl: VALID.publicBaseUrl }),
      (path) => loadRelayConfig(path)
    );
    expect(config?.username).toBeUndefined();
  });
});

describe("relay upload", () => {
  test("PUTs the file and returns the matching public URL", async () => {
    await withFixture(async ({ file, index }) => {
      let putUrl = "";
      let contentType = "";
      let auth = "";
      const restore = mockFetch((input, init) => {
        putUrl = String(input);
        const headers = new Headers(init?.headers);
        contentType = headers.get("content-type") ?? "";
        auth = headers.get("authorization") ?? "";
        expect(init?.method).toBe("PUT");
        expect(init?.body).toBeTruthy();
        return new Response(null, { status: 201 });
      });

      try {
        const url = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        // 上传对象名与下载对象名必须是同一个，否则链接指向不存在的文件。
        const object = putUrl.slice(CONFIG.webdavUrl.length);
        expect(url).toBe(`${CONFIG.publicBaseUrl}${object}`);
        expect(decodeURIComponent(object).endsWith("-note.txt")).toBe(true);
        expect(contentType).toBe("application/octet-stream");
        expect(auth).toBe(`Basic ${Buffer.from("bot:secret").toString("base64")}`);
      } finally {
        restore();
      }
    });
  });

  test("reuses the stored URL instead of uploading the same content twice", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      let heads = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") {
          heads++;
          return new Response(null, { status: 302 });
        }
        puts++;
        return new Response(null, { status: 201 });
      });

      try {
        const first = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        const second = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        expect(second).toBe(first);
        expect(puts).toBe(1);
        // 复用前探测了一次远端，302 也算存在（公开基址通常重定向到网盘直链）。
        expect(heads).toBe(1);
      } finally {
        restore();
      }
    });
  });

  test("survives a restart by reloading the index from disk", async () => {
    await withFixture(async ({ file, index, indexPath }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        puts++;
        return new Response(null, { status: 201 });
      });

      try {
        const first = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        // 换一个从同一份 JSONL 重新加载的索引，模拟进程重启。
        const reloaded = await openRelayIndex(indexPath);
        const second = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index: reloaded,
        });
        expect(second).toBe(first);
        expect(puts).toBe(1);
      } finally {
        restore();
      }
    });
  });

  test("re-uploads and drops the entry when the stored URL is gone", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        // 运维按天清理过，索引里的地址已经 404。
        if (init?.method === "HEAD") return new Response(null, { status: 404 });
        puts++;
        return new Response(null, { status: 201 });
      });

      try {
        const first = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        const second = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        expect(second).not.toBe(first);
        expect(puts).toBe(2);
        expect(index.get(relayCacheKey(await hashFile(file), "note.txt"))?.url).toBe(
          second
        );
      } finally {
        restore();
      }
    });
  });

  test("collapses concurrent uploads of the same content into one", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        puts++;
        return new Response(null, { status: 201 });
      });

      try {
        const [a, b, c] = await Promise.all([
          relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index }),
          relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index }),
          relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index }),
        ]);
        expect(b).toBe(a);
        expect(c).toBe(a);
        expect(puts).toBe(1);
      } finally {
        restore();
      }
    });
  });

  test("treats a renamed file as a separate distribution", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        puts++;
        return new Response(null, { status: 201 });
      });

      try {
        // 同样的字节、不同的名字：复用旧链接会让用户下到一个名字对不上的文件。
        await relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index });
        await relayFile({ config: CONFIG, localPath: file, size: 5, filename: "报告.txt", index });
        expect(puts).toBe(2);
      } finally {
        restore();
      }
    });
  });

  test("surfaces the WebDAV error body on failure", async () => {
    await withFixture(async ({ file, index }) => {
      const restore = mockFetch(() => new Response("wrong password", { status: 401 }));
      try {
        await expect(
          relayFile({
            config: CONFIG,
            localPath: file,
            size: 5,
            filename: "note.txt",
            index,
          })
        ).rejects.toThrow("wrong password");
        // 失败的上传不能留在索引里，否则下次会复用一个不存在的地址。
        expect(index.size()).toBe(0);
      } finally {
        restore();
      }
    });
  });

  test("refuses a file beyond the configured ceiling without touching the network", async () => {
    await withFixture(async ({ file, index }) => {
      let fetched = false;
      const restore = mockFetch(() => {
        fetched = true;
        throw new Error("fetch should not run");
      });
      try {
        await expect(
          relayFile({
            config: CONFIG,
            localPath: file,
            size: CONFIG.maxBytes + 1,
            filename: "huge.bin",
            index,
          })
        ).rejects.toThrow("超过外链分发上限");
        expect(fetched).toBe(false);
      } finally {
        restore();
      }
    });
  });
});

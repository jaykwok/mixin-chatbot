import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../../src/core/config.ts";
import {
  describeRelayExpiry,
  listRelayObjects,
  loadRelayConfig,
  publicUrlFor,
  purgeRelayObjects,
  relayFile,
  sweepExpiredRelayObjects,
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
  handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response,
  /** 让 handler 也看见建目录请求。只有专门验建目录的用例需要。 */
  options?: { handleMkcol?: boolean }
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // 每次上传前都要建一次 uuid 目录，对绝大多数用例是同样的背景噪音，默认答成功，
    // 免得每个 mock 都写一遍。建目录本身的行为见 "relay object layout"。
    if (init?.method === "MKCOL" && !options?.handleMkcol) {
      return new Response(null, { status: 201 });
    }
    return handler(input, init);
  }) as unknown as typeof fetch;
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

  test("expireHours is optional and defaults to never expiring", async () => {
    const config = await withConfigFile(JSON.stringify(VALID), (path) => loadRelayConfig(path));
    expect(config?.expireHours).toBeUndefined();
  });

  test("accepts a fractional expireHours", async () => {
    const config = await withConfigFile(
      JSON.stringify({ ...VALID, expireHours: 0.5 }),
      (path) => loadRelayConfig(path)
    );
    expect(config?.expireHours).toBe(0.5);
  });

  test("rejects an unusable expireHours", async () => {
    // NaN/Infinity 过不了 JSON（都会变成 null），所以这里只列真正写得出来的错法。
    for (const bad of [0, -1, "8", true, 24 * 365 + 1]) {
      await withConfigFile(JSON.stringify({ ...VALID, expireHours: bad }), (path) => {
        expect(() => loadRelayConfig(path)).toThrow("expireHours");
      });
    }
  });

  test("treats an explicit null expireHours as absent", async () => {
    const config = await withConfigFile(
      JSON.stringify({ ...VALID, expireHours: null }),
      (path) => loadRelayConfig(path)
    );
    expect(config?.expireHours).toBeUndefined();
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
        expect(decodeURIComponent(object).endsWith("/note.txt")).toBe(true);
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

  test("reuses a proxied URL when the probe reports the stored size", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        // 后端不做 302 而是自己代理时，HEAD 是 200 + 真实长度。
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "Content-Length": "5" },
          });
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
      } finally {
        restore();
      }
    });
  });

  // alist 之类的文件服务把业务错误塞进 HTTP 200 的 JSON 里（"sign invalid"、
  // "object not found" 都是 200）。只看状态码会把错误信封当成文件还在，然后
  // 把一条死链交给用户。
  test("does not mistake a 200 error envelope for a live object", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const envelope = JSON.stringify({ code: 401, message: "sign invalid" });
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(envelope.length),
            },
          });
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
        // 错误信封的长度对不上存下的大小，判为已失效并重传。
        expect(second).not.toBe(first);
        expect(puts).toBe(2);
      } finally {
        restore();
      }
    });
  });

  test("survives a restart by reloading the index from disk", async () => {
    await withFixture(async ({ file, index, indexPath }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { status: 302 });
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
        if (init?.method === "HEAD") return new Response(null, { status: 302 });
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
        if (init?.method === "HEAD") return new Response(null, { status: 302 });
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

  test("names the likely cause when the backend fails with a 5xx", async () => {
    await withFixture(async ({ file, index }) => {
      const restore = mockFetch((_input, init) =>
        init?.method === "PUT"
          ? new Response('{"code":500,"message":"refresh token expired"}', { status: 500 })
          : new Response(null, { status: 404 })
      );
      try {
        const error = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        }).then(
          () => null,
          (e: unknown) => e as Error
        );
        expect(error).toBeInstanceOf(Error);
        // 群成员对「HTTP 500」无能为力；这句话要指向真正能修的人和真正的原因。
        expect(error!.message).toContain("授权");
        expect(error!.message).toContain("管理员");
        // 后端原文要带上，管理员据此才能定位。
        expect(error!.message).toContain("refresh token expired");
      } finally {
        restore();
      }
    });
  });
});

describe("relay expiry", () => {
  const EXPIRING: RelayConfig = { ...CONFIG, expireHours: 8 };

  /** 直接往索引里塞一条指定年龄的记录，避免测试真的等 8 小时。 */
  async function seed(index: RelayIndex, ageHours: number, name = "note.txt") {
    const key = relayCacheKey("deadbeef", name);
    await index.remember({
      key,
      url: `${EXPIRING.publicBaseUrl}${encodeURIComponent(`20260831-uuid-${name}`)}`,
      name,
      size: 5,
      at: new Date(Date.now() - ageHours * 60 * 60_000).toISOString(),
    });
    return key;
  }

  test("deletes an object whose link has expired and drops its index entry", async () => {
    await withFixture(async ({ index }) => {
      const key = await seed(index, 9);
      const deleted: string[] = [];
      const restore = mockFetch((input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        expect(deleted).toHaveLength(1);
        // 删的必须是 WebDAV 地址，不是公开下载地址。
        expect(deleted[0].startsWith(EXPIRING.webdavUrl)).toBe(true);
        expect(deleted[0]).toContain("note.txt");
        expect(index.get(key)).toBeUndefined();
      } finally {
        restore();
      }
    });
  });

  test("leaves a still-live object alone", async () => {
    await withFixture(async ({ index }) => {
      const key = await seed(index, 7);
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        expect(called).toBe(false);
        expect(index.get(key)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  test("does nothing at all when no expiry is configured", async () => {
    await withFixture(async ({ index }) => {
      const key = await seed(index, 10_000);
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: CONFIG, index });
        expect(called).toBe(false);
        expect(index.get(key)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  test("keeps the entry for a retry when the delete fails", async () => {
    await withFixture(async ({ index }) => {
      const key = await seed(index, 9);
      const restore = mockFetch(() => new Response("backend down", { status: 503 }));
      try {
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        // 后端临时不可达就丢掉记录的话，那个对象再没人管，会变成网盘上的永久孤儿。
        expect(index.get(key)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  test("treats an already-absent object as successfully deleted", async () => {
    await withFixture(async ({ index }) => {
      const key = await seed(index, 9);
      const restore = mockFetch(() => new Response(null, { status: 404 }));
      try {
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        expect(index.get(key)).toBeUndefined();
      } finally {
        restore();
      }
    });
  });

  test("drops but does not delete an entry left over from another publicBaseUrl", async () => {
    await withFixture(async ({ index }) => {
      const key = relayCacheKey("deadbeef", "old.txt");
      await index.remember({
        key,
        url: "https://previous-backend.example.com/d/relay/20260101-uuid-old.txt",
        name: "old.txt",
        size: 5,
        at: new Date(Date.now() - 9 * 60 * 60_000).toISOString(),
      });
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        // 换过后端之后我们没有能力再删旧对象，但也不该把请求发给新后端。
        expect(called).toBe(false);
        expect(index.get(key)).toBeUndefined();
      } finally {
        restore();
      }
    });
  });

  test("a cache hit refreshes the deadline instead of re-uploading", async () => {
    await withFixture(async ({ file, index }) => {
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "PUT") {
          puts++;
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 302 });
      });
      try {
        const first = await relayFile({
          config: EXPIRING,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        const key = relayCacheKey(await hashFile(file), "note.txt");
        // 把记录改老，模拟这份内容已经躺了 7 小时。
        const aged = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
        await index.remember({ ...index.get(key)!, at: aged });

        const second = await relayFile({
          config: EXPIRING,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });

        expect(second).toBe(first);
        expect(puts).toBe(1);
        // 时间戳被刷新了，所以第二个人拿到的链接有完整寿命，而不是只剩一小时。
        expect(index.get(key)!.at > aged).toBe(true);
        // 而且刷新之后不会被随后的清理误删。
        await sweepExpiredRelayObjects({ config: EXPIRING, index });
        expect(index.get(key)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  test("does not refresh the deadline when the object is already gone", async () => {
    await withFixture(async ({ file, index }) => {
      const key = relayCacheKey(await hashFile(file), "note.txt");
      const aged = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
      await index.remember({
        key,
        url: `${EXPIRING.publicBaseUrl}stale-object.txt`,
        name: "note.txt",
        size: 5,
        at: aged,
      });
      let puts = 0;
      const restore = mockFetch((_input, init) => {
        if (init?.method === "PUT") {
          puts++;
          return new Response(null, { status: 201 });
        }
        // 探测报告对象已不存在。
        return new Response(null, { status: 404 });
      });
      try {
        const url = await relayFile({
          config: EXPIRING,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        // 死链不能靠刷新时间戳续命，必须真的重传。
        expect(puts).toBe(1);
        expect(url).not.toContain("stale-object.txt");
      } finally {
        restore();
      }
    });
  });
});

describe("relay object layout", () => {
  test("keeps the original filename as the last path segment", async () => {
    await withFixture(async ({ file, index }) => {
      const restore = mockFetch(() => new Response(null, { status: 201 }));
      try {
        const url = await relayFile({
          config: CONFIG,
          localPath: file,
          size: 5,
          filename: "电信安全产品手册-2025.pdf",
          index,
        });
        // 后端把对象名原样写进 Content-Disposition，所以最后一段必须就是原文件名——
        // uuid 拌进文件名里的话，每个人下到的都是 20260831-<uuid>-电信安全产品手册-2025.pdf。
        const segments = new URL(url).pathname.split("/");
        expect(decodeURIComponent(segments.at(-1)!)).toBe("电信安全产品手册-2025.pdf");
        // 不可枚举性挪到了目录段上，要猜的还是那个 uuid。
        expect(segments.at(-2)).toMatch(/^\d{8}-[0-9a-f-]{36}$/);
      } finally {
        restore();
      }
    });
  });

  test("creates the directory before putting the file into it", async () => {
    await withFixture(async ({ file, index }) => {
      const calls: string[] = [];
      const restore = mockFetch(
        (input, init) => {
          calls.push(`${init?.method} ${String(input)}`);
          return new Response(null, { status: 201 });
        },
        { handleMkcol: true }
      );
      try {
        await relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index });
        // WebDAV 的 PUT 不会自动建父目录，顺序反了就是 409。
        expect(calls[0].startsWith("MKCOL")).toBe(true);
        expect(calls[1].startsWith("PUT")).toBe(true);
        expect(calls[0]).toMatch(/\/\d{8}-[0-9a-f-]+\/$/);
        expect(calls[1].endsWith("/note.txt")).toBe(true);
      } finally {
        restore();
      }
    });
  });

  test("reports a failed directory creation like any other backend failure", async () => {
    await withFixture(async ({ file, index }) => {
      const restore = mockFetch(
        (_input, init) =>
          init?.method === "MKCOL"
            ? new Response("insufficient storage", { status: 507 })
            : new Response(null, { status: 201 }),
        { handleMkcol: true }
      );
      try {
        await expect(
          relayFile({ config: CONFIG, localPath: file, size: 5, filename: "note.txt", index })
        ).rejects.toThrow("存储空间不足");
        // 目录都没建起来就别往索引里记一条指向空气的地址。
        expect(index.size()).toBe(0);
      } finally {
        restore();
      }
    });
  });

  test("deletes the whole directory, not just the file inside it", async () => {
    await withFixture(async ({ index }) => {
      const key = relayCacheKey("deadbeef", "note.txt");
      const directory = "20260831-11111111-2222-3333-4444-555555555555";
      await index.remember({
        key,
        url: `${CONFIG.publicBaseUrl}${directory}/${encodeURIComponent("note.txt")}`,
        name: "note.txt",
        size: 5,
        at: new Date(Date.now() - 100 * 60 * 60_000).toISOString(),
      });
      const deleted: string[] = [];
      const restore = mockFetch((input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: { ...CONFIG, expireHours: 8 }, index });
        // 只删文件会在后端留下一地空目录。
        expect(deleted).toEqual([`${CONFIG.webdavUrl}${directory}`]);
      } finally {
        restore();
      }
    });
  });

  test("still deletes objects uploaded under the old flat layout", async () => {
    await withFixture(async ({ index }) => {
      const key = relayCacheKey("deadbeef", "old.txt");
      const flat = "20260101-uuid-old.txt";
      await index.remember({
        key,
        url: `${CONFIG.publicBaseUrl}${encodeURIComponent(flat)}`,
        name: "old.txt",
        size: 5,
        at: new Date(Date.now() - 100 * 60 * 60_000).toISOString(),
      });
      const deleted: string[] = [];
      const restore = mockFetch((input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: { ...CONFIG, expireHours: 8 }, index });
        // 换布局之前发出去的对象没有目录段，仍然要能被清掉。
        expect(deleted).toEqual([`${CONFIG.webdavUrl}${encodeURIComponent(flat)}`]);
        expect(index.size()).toBe(0);
      } finally {
        restore();
      }
    });
  });

  test("refuses to delete anything it cannot parse back to an object", async () => {
    await withFixture(async ({ index }) => {
      const key = relayCacheKey("deadbeef", "deep.txt");
      await index.remember({
        key,
        // 比「目录/文件名」更深一层的地址不是我们传上去的。
        url: `${CONFIG.publicBaseUrl}a/b/c.txt`,
        name: "deep.txt",
        size: 5,
        at: new Date(Date.now() - 100 * 60 * 60_000).toISOString(),
      });
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        const result = await purgeRelayObjects({ config: CONFIG, index });
        // 宁可报成孤儿让人工处理，也不要往猜出来的路径上发 DELETE。
        expect(called).toBe(false);
        expect(result.orphaned).toBe(1);
      } finally {
        restore();
      }
    });
  });
});

describe("relay signing", () => {
  const SIGNED: RelayConfig = {
    ...CONFIG,
    signSecret: "super-secret-token",
    signPathPrefix: "/relay/",
  };

  function signOf(url: string): string {
    return new URL(url).searchParams.get("sign")!;
  }

  test("matches the backend's signature byte for byte", () => {
    // 固定向量，用一份独立的 HMAC-SHA256 实现算出来的（Python 的 urlsafe_b64encode 与后端
    // 用的 Go base64.URLEncoding 是同一套：URL 字母表 + 保留 = 填充）。签名算法一旦漂移，
    // 所有链接都会 403，而那种失败只有群里有人点开才会暴露——所以要钉死在这里。
    const name = "20260831-abc-报告.pdf";
    const stored = `${SIGNED.publicBaseUrl}${encodeURIComponent(name)}`;
    expect(signOf(publicUrlFor(SIGNED, stored))).toBe(
      "19wdmNkxaxaFQcwPI4o0u6aLo_l1h0zoXvs5odZSXvI=:0"
    );
  });

  test("keeps the base64 padding the backend expects", () => {
    // Node 的 digest("base64url") 会去掉这个 =，用错就是全盘验签失败。
    const signature = signOf(publicUrlFor(SIGNED, `${SIGNED.publicBaseUrl}x.bin`));
    expect(signature.split(":")[0].endsWith("=")).toBe(true);
    expect(signature).not.toContain("+");
  });

  test("expires the signature instead of the file", () => {
    const url = publicUrlFor({ ...SIGNED, expireHours: 8 }, `${SIGNED.publicBaseUrl}x.bin`);
    const expire = Number(signOf(url).split(":")[1]);
    expect(expire - Math.floor(Date.now() / 1000)).toBeCloseTo(8 * 3600, -1);
  });

  test("signs nothing when no secret is configured", () => {
    const stored = `${CONFIG.publicBaseUrl}x.bin`;
    expect(publicUrlFor(CONFIG, stored)).toBe(stored);
  });

  test("derives the signing path prefix from the public base url", async () => {
    const cases: [string, string][] = [
      ["https://files.example.com/d/relay/", "/relay/"],
      ["https://files.example.com/d/", "/"],
      ["https://files.example.com/p/a/b/", "/a/b/"],
    ];
    for (const [publicBaseUrl, expected] of cases) {
      const config = await withConfigFile(
        JSON.stringify({ ...VALID, publicBaseUrl, signSecret: "s" }),
        (path) => loadRelayConfig(path)
      );
      expect(config?.signPathPrefix).toBe(expected);
    }
  });

  test("refuses to guess a signing path it cannot derive", async () => {
    // 反代挂在子路径下之类的形状推不出来。宁可拒绝启动，也不要签出一批必然 403 的链接。
    await withConfigFile(
      JSON.stringify({ ...VALID, publicBaseUrl: "https://files.example.com/store/", signSecret: "s" }),
      (path) => {
        expect(() => loadRelayConfig(path)).toThrow("signPathPrefix");
      }
    );
  });

  test("normalizes an explicit signing path prefix", async () => {
    const config = await withConfigFile(
      JSON.stringify({ ...VALID, signSecret: "s", signPathPrefix: "store/relay" }),
      (path) => loadRelayConfig(path)
    );
    expect(config?.signPathPrefix).toBe("/store/relay/");
  });

  test("rejects a signing path prefix with no secret to use it", async () => {
    // 静默忽略只会让人以为签名已经生效。
    await withConfigFile(JSON.stringify({ ...VALID, signPathPrefix: "/relay/" }), (path) => {
      expect(() => loadRelayConfig(path)).toThrow("signSecret");
    });
  });

  test("stores the bare url but hands out a signed one", async () => {
    await withFixture(async ({ file, index }) => {
      const restore = mockFetch(() => new Response(null, { status: 201 }));
      try {
        const url = await relayFile({
          config: SIGNED,
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        expect(url).toContain("sign=");
        // 索引里存的必须是裸地址：签名有时效，存进去第二天就是一条死链，而反推对象名
        // （删除、清理都靠它）也只认裸地址。
        const stored = index.entries()[0].url;
        expect(stored).not.toContain("sign");
        expect(url.startsWith(stored)).toBe(true);
      } finally {
        restore();
      }
    });
  });

  test("re-signs a cache hit instead of replaying the old link", async () => {
    await withFixture(async ({ file, index }) => {
      const digest = await hashFile(file);
      const key = relayCacheKey(digest, "note.txt");
      const stored = `${SIGNED.publicBaseUrl}${encodeURIComponent("20260831-uuid-note.txt")}`;
      await index.remember({ key, url: stored, name: "note.txt", size: 5, at: new Date().toISOString() });

      const probes: string[] = [];
      let puts = 0;
      const restore = mockFetch((input, init) => {
        if (init?.method === "PUT") puts++;
        if (init?.method === "HEAD") probes.push(String(input));
        return new Response(null, { status: 302 });
      });
      try {
        const url = await relayFile({
          config: { ...SIGNED, expireHours: 8 },
          localPath: file,
          size: 5,
          filename: "note.txt",
          index,
        });
        // 命中去重就不该重传，但拿到的链接得是新签的、寿命完整的。
        expect(puts).toBe(0);
        expect(url.startsWith(stored)).toBe(true);
        expect(Number(signOf(url).split(":")[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
        // 探测也必须带签名：后端开了强制验签时不带签名一律 401，会被当成对象没了而每次重传。
        expect(probes).toHaveLength(1);
        expect(probes[0]).toContain("sign=");
      } finally {
        restore();
      }
    });
  });

  test("keeps the file on disk when the signature carries the expiry", async () => {
    await withFixture(async ({ index }) => {
      const key = relayCacheKey("deadbeef", "note.txt");
      await index.remember({
        key,
        url: `${SIGNED.publicBaseUrl}${encodeURIComponent("20260831-uuid-note.txt")}`,
        name: "note.txt",
        size: 5,
        at: new Date(Date.now() - 100 * 60 * 60_000).toISOString(),
      });
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        await sweepExpiredRelayObjects({ config: { ...SIGNED, expireHours: 8 }, index });
        // 签名到期就够了，删文件只会逼着下次重传一遍。
        expect(called).toBe(false);
        expect(index.get(key)).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  test("tells the group the deadline and nothing about the backend", () => {
    expect(describeRelayExpiry(CONFIG)).toBe("");
    // 删文件那种模式过期后没有补救途径，多一层提醒；签名模式只说期限——文件在后端留没留
    // 是运维细节，群成员该做的事一样，就是在期限内下载。
    expect(describeRelayExpiry({ ...CONFIG, expireHours: 8 })).toContain("文件会被删除");
    const signed = describeRelayExpiry({ ...SIGNED, expireHours: 8 });
    expect(signed).toContain("8 小时后失效");
    expect(signed).not.toContain("文件");
  });
});

describe("relay admin", () => {
  /** 直接往索引里塞几条记录，避免每个用例都真的跑一遍上传。 */
  async function seedThree(index: RelayIndex) {
    const rows = [
      { name: "old.pdf", hours: 72 },
      { name: "mid.zip", hours: 9 },
      { name: "new.iso", hours: 1 },
    ];
    for (const row of rows) {
      await index.remember({
        key: relayCacheKey(row.name, row.name),
        url: `${CONFIG.publicBaseUrl}${encodeURIComponent(`20260831-uuid-${row.name}`)}`,
        name: row.name,
        size: 5,
        at: new Date(Date.now() - row.hours * 60 * 60_000).toISOString(),
      });
    }
  }

  test("lists live entries oldest first", async () => {
    await withFixture(async ({ index }) => {
      await seedThree(index);
      await index.forget(relayCacheKey("mid.zip", "mid.zip"));

      const objects = await listRelayObjects({ config: CONFIG, index });
      // 墓碑掉的那条不该出现；最该被清掉的排在最前面。
      expect(objects.map((o) => o.name)).toEqual(["old.pdf", "new.iso"]);
      expect(objects[0].size).toBe(5);
    });
  });

  test("purges everything when no filter is given", async () => {
    await withFixture(async ({ index }) => {
      await seedThree(index);
      const deleted: string[] = [];
      const restore = mockFetch((input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return new Response(null, { status: 204 });
      });
      try {
        const result = await purgeRelayObjects({ config: CONFIG, index });
        expect(result).toEqual({ matched: 3, deleted: 3, failed: 0, orphaned: 0 });
        expect(deleted).toHaveLength(3);
        expect(deleted.every((url) => url.startsWith(CONFIG.webdavUrl))).toBe(true);
        expect(index.size()).toBe(0);
      } finally {
        restore();
      }
    });
  });

  test("purges only what the filter matches", async () => {
    await withFixture(async ({ index }) => {
      await seedThree(index);
      const deleted: string[] = [];
      const restore = mockFetch((input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return new Response(null, { status: 204 });
      });
      try {
        const result = await purgeRelayObjects({ config: CONFIG, index, match: ".zip" });
        expect(result.matched).toBe(1);
        expect(result.deleted).toBe(1);
        expect(deleted[0]).toContain("mid.zip");
        // 另外两条必须原样留着——手滑打错关键字不该清掉别人的链接。
        expect(index.size()).toBe(2);
      } finally {
        restore();
      }
    });
  });

  test("keeps the entry and reports the failure when the backend rejects a delete", async () => {
    await withFixture(async ({ index }) => {
      await seedThree(index);
      const restore = mockFetch(() => new Response("backend down", { status: 503 }));
      try {
        const result = await purgeRelayObjects({ config: CONFIG, index });
        expect(result.deleted).toBe(0);
        expect(result.failed).toBe(3);
        expect(index.size()).toBe(3);
      } finally {
        restore();
      }
    });
  });

  test("reports entries it can no longer delete separately from failures", async () => {
    await withFixture(async ({ index }) => {
      await index.remember({
        key: relayCacheKey("deadbeef", "old.txt"),
        url: "https://previous-backend.example.com/d/relay/20260101-uuid-old.txt",
        name: "old.txt",
        size: 5,
        at: new Date().toISOString(),
      });
      let called = false;
      const restore = mockFetch(() => {
        called = true;
        return new Response(null, { status: 204 });
      });
      try {
        const result = await purgeRelayObjects({ config: CONFIG, index });
        // 换过后端之后我们删不掉旧对象，但也绝不能把请求发给新后端。
        expect(called).toBe(false);
        expect(result).toEqual({ matched: 1, deleted: 0, failed: 0, orphaned: 1 });
        expect(index.size()).toBe(0);
      } finally {
        restore();
      }
    });
  });

  test("refuses to purge when the feature is not configured", async () => {
    await withFixture(async ({ index }) => {
      const error = await purgeRelayObjects({ config: null, index }).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain("relay.json");
    });
  });
});

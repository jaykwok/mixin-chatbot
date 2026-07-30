import { describe, expect, test } from "bun:test";
import { buildSendTools } from "../../src/agent/send-tools.ts";

describe("attachment send tools", () => {
  test("honors the Pi tool abort signal before downloading", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const imageTool = buildSendTools(
      () =>
        "https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=abort-test",
      "group-a",
      ".",
      "."
    ).find((tool) => tool.name === "send_image")!;

    try {
      await expect(
        imageTool.execute(
          "send-aborted-image",
          { source: "https://example.com/image.png" },
          controller.signal,
          undefined,
          {} as never
        )
      ).rejects.toThrow();
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

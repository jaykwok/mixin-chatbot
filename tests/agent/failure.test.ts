import { describe, expect, test } from "bun:test";
import {
  describeRequestFailure,
  extractHttpStatus,
  redactSecrets,
} from "../../src/agent/failure.ts";

describe("请求失败回执", () => {
  test("额度用尽给出续费/换模型的结论，并附带 provider 原文", () => {
    const reply = describeRequestFailure(
      new Error(
        '模型未返回回复：429: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}'
      )
    );
    expect(reply).toContain("额度或余额已经用完");
    expect(reply).toContain("请联系管理员");
    expect(reply).toContain("原始错误：模型未返回回复：429:");
    expect(reply).toContain("insufficient_quota");
    // 额度耗尽也是 429，但「稍后再试」对它没有意义。
    expect(reply).not.toContain("正在限流");
  });

  test("纯限流与额度耗尽区分开", () => {
    const reply = describeRequestFailure(
      new Error('模型未返回回复：429: {"error":{"message":"Rate limit exceeded, retry later"}}')
    );
    expect(reply).toContain("正在限流");
    expect(reply).not.toContain("额度或余额已经用完");
  });

  test("凭证失效指向 configure，且不把 key 带进群", () => {
    const reply = describeRequestFailure(
      new Error(
        '401: {"error":{"message":"Incorrect API key provided: sk-abcdef1234567890"}} (api_key=sk-abcdef1234567890)'
      )
    );
    expect(reply).toContain("拒绝了当前凭证");
    expect(reply).not.toContain("abcdef1234567890");
  });

  test("模型服务 5xx 说明会自行恢复", () => {
    const reply = describeRequestFailure(new Error("模型未返回回复：zai (503): upstream overloaded"));
    expect(reply).toContain("故障或过载");
  });

  test("网络不通归到出网检查而不是模型侧", () => {
    const reply = describeRequestFailure(
      new Error("模型未返回回复：fetch failed: connect ETIMEDOUT 1.2.3.4:443")
    );
    expect(reply).toContain("连不上模型服务");
  });

  test("上下文超限提示用户自己 /clear", () => {
    const reply = describeRequestFailure(
      new Error("模型未返回回复：400: This model's maximum context length is 128000 tokens")
    );
    expect(reply).toContain("/clear");
  });

  test("模型 id 失效指向 models.json 核对", () => {
    const reply = describeRequestFailure(
      new Error('模型未返回回复：404: {"error":{"message":"The model `glm-x` does not exist"}}')
    );
    expect(reply).toContain("找不到配置的模型 id");
  });

  test("配置缺失优先于状态码分类", () => {
    const reply = describeRequestFailure(
      new Error("无法读取 data/config/models.json。请先生成 AI 配置：运行 bun run configure")
    );
    expect(reply).toContain("模型配置有问题");
  });

  test("模型生成成功但发送失败时不怪模型", () => {
    const reply = describeRequestFailure(new Error("Pi 回复生成成功，但群聊消息发送失败"));
    expect(reply).toContain("发到群里失败");
  });

  test("没有任何线索的空回复单独描述，可直接重发", () => {
    const reply = describeRequestFailure(new Error("Pi 未返回回复"));
    expect(reply).toContain("异常空回复");
    expect(reply).toContain("原始错误：Pi 未返回回复");
  });

  test("认不出的失败保留原文并要求转给管理员", () => {
    const reply = describeRequestFailure(new Error("something went sideways"));
    expect(reply).toContain("没能自动归类");
    expect(reply).toContain("原始错误：something went sideways");
  });

  test("非 Error 抛出物也能生成回执", () => {
    expect(describeRequestFailure("boom")).toContain("原始错误：boom");
    expect(describeRequestFailure(undefined)).toContain("⚠️");
  });

  test("原文压成一行并截断，不刷屏", () => {
    const reply = describeRequestFailure(new Error(`超长报文\n${"报文".repeat(400)}`));
    expect(reply).toContain("（已截断）");
    expect(reply).not.toContain("\n超长报文");
    expect(reply.length).toBeLessThan(600);
  });
});

describe("状态码识别", () => {
  test("覆盖 pi-ai 与各家 SDK 的常见写法", () => {
    expect(extractHttpStatus('429: {"error":"x"}')).toBe(429);
    expect(extractHttpStatus("zai (402): no balance")).toBe(402);
    expect(extractHttpStatus("Request failed with HTTP 503")).toBe(503);
    expect(extractHttpStatus("403 status code (no body)")).toBe(403);
    expect(extractHttpStatus("statusCode: 401")).toBe(401);
    expect(extractHttpStatus("no status here")).toBeUndefined();
    // 正文里的普通数字不能被当成状态码。
    expect(extractHttpStatus("used 429000 tokens")).toBeUndefined();
  });
});

describe("凭据脱敏", () => {
  test("抹掉 key、Bearer 与 URL 参数", () => {
    expect(redactSecrets("key sk-live-abcdef123456")).toBe("key sk-***");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toContain("Bearer ***");
    expect(redactSecrets('{"api_key":"9f8e7d6c5b4a"}')).toBe('{"api_key":"***"}');
    expect(redactSecrets("https://example.com/send?key=abc123&type=text")).toBe(
      "https://example.com/send?key=***&type=text"
    );
  });

  test("不动普通报错文本", () => {
    const text = "You exceeded your current quota, please check your plan";
    expect(redactSecrets(text)).toBe(text);
  });
});

#!/usr/bin/env bun
// 先交互形成草稿，运维脚本再停机并提交；填写和取消都不影响运行中的机器人。
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, text } from "@clack/prompts";
import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NATIVE_FILE_MAX_BYTES } from "../../src/core/config.ts";
import { archiveFile, replaceFile, withMaintenance } from "../../src/core/maintenance.ts";
import { RELAY_CONFIG_PATH, RELAY_INDEX_PATH } from "../../src/core/storage.ts";
import { DEFAULT_RELAY_MAX_BYTES, DEFAULT_RELAY_EXPIRE_HOURS, DEFAULT_RELAY_CLEANUP_GRACE_MINUTES, relayBackendId, validateRelayConfig, type RelayConfig } from "../../src/integrations/relay.ts";
import { readRelayIndex, RelayIndexFormatError } from "../../src/integrations/relay-index.ts";
import { normalizeRelayUrlInput, suggestRelayRegion } from "./relay-url.ts";

const MIB = 1024 ** 2;
const CONFIG_FIELDS = ["provider", "endpoint", "region", "bucket", "accessKeyId", "secretAccessKey", "sessionToken", "prefix", "forcePathStyle", "maxBytes", "expireHours", "cleanupGraceMinutes"];

function bail<T>(value: T | symbol): T {
  if (isCancel(value)) throw new DOMException("配置已取消", "AbortError");
  return value as T;
}

async function currentFile(): Promise<string | null> {
  try { return await readFile(RELAY_CONFIG_PATH, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function fingerprint(raw: string | null): string | null {
  return raw === null ? null : createHash("sha256").update(raw).digest("hex");
}

function requireUrl(value: string | undefined): string | undefined {
  try { normalizeRelayUrlInput(value); }
  catch (error) { return error instanceof Error ? error.message : "请输入有效的 S3 服务端点"; }
}

async function askText(message: string, initialValue: string, validate?: (value: string | undefined) => string | undefined): Promise<string> {
  return bail<string>(await text({ message, initialValue, defaultValue: initialValue, validate })).trim();
}

async function askSecret(label: string, previous?: string): Promise<string> {
  const value = bail<string>(await password({
    // ASCII mask: the default ▪ shows as "?" in Windows GBK consoles.
    mask: "*",
    message: label + (previous ? "（留空沿用已保存值）" : ""),
    validate: (input) => input?.trim() || previous ? undefined : "不能为空",
  }));
  return value.trim() ? value : previous!;
}

function validationError(config: unknown): string | undefined {
  try { validateRelayConfig(config); }
  catch (error) { return error instanceof Error ? error.message : "配置无效"; }
}

function displayUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function checkLedger(enabling: boolean) {
  try { return readRelayIndex(RELAY_INDEX_PATH); }
  catch (error) {
    if (enabling && error instanceof RelayIndexFormatError) {
      throw new Error("拒绝保存 S3 外链配置：" + error.message, { cause: error });
    }
    log.warn("外链账本无法只读核验；请检查账本和旧后端是否仍有对象。" +
      (enabling ? "保存配置不代表账本可用或服务能够启动。" : "停用将保留账本和远端对象。"));
    return [];
  }
}

async function prepare(draftPath: string): Promise<void> {
  intro("可选的大文件外链配置");
  note("超过 " + NATIVE_FILE_MAX_BYTES / MIB + " MiB 的本地文件可上传到私有 S3 存储桶，再发送限时下载链接。\n" +
    "填写期间机器人继续运行；确认保存后，原本运行中的机器人会短暂重启以应用配置。", "配置方式");
  const raw = await currentFile();
  let fields: Record<string, unknown> = {};
  let previous: RelayConfig | null = null;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      previous = validateRelayConfig(parsed);
      fields = parsed as Record<string, unknown>;
    } catch {
      log.warn("现有 relay.json 无法通过校验，将重新填写；确认保存前会保留原文件。");
    }
  }
  const action = bail<string>(await select({
    message: "外链设置", initialValue: "configure",
    options: [
      { value: "configure", label: raw === null ? "启用外链" : "修改外链配置" },
      ...(raw === null ? [] : [{ value: "disable", label: "停用外链", hint: "归档配置，保留远端文件和外链账本" }]),
      { value: "cancel", label: "返回，不修改" },
    ],
  }));
  if (action === "cancel") throw new DOMException("配置已取消", "AbortError");

  let config: Record<string, unknown> | null = null;
  if (action === "disable") {
    note("将停用大文件外链分发，并把 relay.json 归档到 backup/rm。\n" +
      "远端文件和外链账本会保留；停用期间机器人不会执行到期清理，后端签名仍按自身期限失效。", "停用预览");
  } else {
    note([
      "使用兼容 S3 Signature V4 的私有桶，关闭公共访问，授予专用凭据对象读、写、删除权限。",
      "Endpoint 填服务地址（不含桶名或对象路径），下载直接访问这个端点，不经过机器人或隧道。",
      "阿里云 OSS 使用 S3 兼容端点，例如 s3.oss-cn-hangzhou.aliyuncs.com。",
      "腾讯 COS 桶名包含 APPID，端点形如 cos.ap-chengdu.myqcloud.com（不含桶名）；天翼云端点和区域按所选产品、资源池的 S3 文档填写。",
      "对象默认放在桶根目录，路径为 日期-UUID/原文件名，建议使用专用桶；高级设置可改放子目录。",
      "云端另设生命周期兜底；关闭版本控制、对象锁及复制，避免删除后仍保留历史副本。",
      "默认下载有效 2 小时，额外保留 30 分钟后清理。查看和重发不延长期限。",
      "此向导只校验配置，不上传文件，也不修改云端权限或生命周期。",
    ].join("\n"), "对象存储准备");
    const next: RelayConfig = { ...(previous ?? {
      provider: "s3", endpoint: "", region: "", bucket: "", accessKeyId: "", secretAccessKey: "",
      prefix: "", forcePathStyle: false, maxBytes: DEFAULT_RELAY_MAX_BYTES,
      expireHours: DEFAULT_RELAY_EXPIRE_HOURS, cleanupGraceMinutes: DEFAULT_RELAY_CLEANUP_GRACE_MINUTES,
    }) };
    next.endpoint = normalizeRelayUrlInput(await askText("S3 服务端点 Endpoint", next.endpoint, requireUrl));
    // A new endpoint starts from the region it names; the same endpoint keeps the saved region.
    const region = suggestRelayRegion(next.endpoint);
    if (region && previous?.endpoint !== next.endpoint) next.region = region;
    next.region = await askText("S3 区域 Region", next.region, value => value?.trim() ? undefined : "不能为空");
    next.bucket = await askText("私有存储桶 Bucket", next.bucket, value => value?.trim() ? undefined : "不能为空");
    const style = bail<string>(await select({
      message: "S3 寻址方式", initialValue: next.forcePathStyle ? "path" : "virtual",
      options: [
        { value: "virtual", label: "桶名在域名中（Virtual hosted）", hint: "多数公有云；例如 bucket.endpoint/object" },
        { value: "path", label: "桶名在路径中（Path style）", hint: "按厂商要求选择；IP、localhost、MinIO 常用" },
      ],
    }));
    next.forcePathStyle = style === "path";
    // Consoles often show the bucket domain; virtual-hosted style would add the bucket again. Fix it before credentials.
    const endpoint = new URL(next.endpoint);
    if (!next.forcePathStyle && endpoint.hostname.startsWith(next.bucket + ".")) {
      endpoint.hostname = endpoint.hostname.slice(next.bucket.length + 1);
      if (!bail<boolean>(await confirm({
        message: "服务端点已包含桶名，Virtual hosted 会自动加桶名；改用 " + endpoint.origin + "？", initialValue: true,
      }))) throw new Error("服务端点不能包含桶名；请重新运行外链配置向导");
      next.endpoint = endpoint.origin;
    }
    next.accessKeyId = await askSecret("Access Key ID", previous?.endpoint === next.endpoint ? previous.accessKeyId : undefined);
    const sameAccount = previous?.endpoint === next.endpoint && previous.accessKeyId === next.accessKeyId;
    next.secretAccessKey = await askSecret("Secret Access Key", sameAccount ? previous?.secretAccessKey : undefined);
    // An endpoint/account switch must never silently carry a token to a different service.
    if (!sameAccount) delete next.sessionToken;
    const tokenMode = bail<string>(await select({
      message: "临时凭据 Session Token", initialValue: next.sessionToken ? "keep" : "none",
      options: [
        ...(next.sessionToken ? [{ value: "keep", label: "沿用已保存的 Token" }] : []),
        { value: "none", label: "不使用临时 Token" }, { value: "set", label: "填写新的 Token" },
      ],
    }));
    if (tokenMode === "set") next.sessionToken = await askSecret("Session Token");
    else if (tokenMode === "none") delete next.sessionToken;
    const advanced = bail<boolean>(await confirm({
      message: "调整高级设置（目录、文件上限、有效期、删除余量）？", initialValue: false,
    }));
    if (advanced) {
      // No defaultValue: clack would turn a cleared field back into the old directory, leaving no way to choose the root.
      next.prefix = bail<string>(await text({ message: "对象目录 Prefix（清空表示桶根目录）", initialValue: next.prefix,
        validate: value => validationError({ ...next, prefix: value ?? "" }) })).trim();
      next.maxBytes = Number(await askText("单文件外链上限（MiB，须大于 " + NATIVE_FILE_MAX_BYTES / MIB + "，最大 5120）",
        String(next.maxBytes / MIB), value => validationError({ ...next, maxBytes: Number(value) * MIB }))) * MIB;
      next.expireHours = Number(await askText("链接有效期（小时，最多 168）", String(next.expireHours),
        value => validationError({ ...next, expireHours: Number(value) })));
      next.cleanupGraceMinutes = Number(await askText("删除余量（分钟，链接到期后额外保留）", String(next.cleanupGraceMinutes),
        value => validationError({ ...next, cleanupGraceMinutes: Number(value) })));
    }
    const validated = validateRelayConfig(next);
    config = { ...fields };
    for (const field of CONFIG_FIELDS) delete config[field];
    Object.assign(config, validated);
    note([
      "服务端点：" + displayUrl(validated.endpoint),
      "区域：" + validated.region + "；桶：" + validated.bucket,
      "对象路径：" + validated.prefix + "日期-UUID/原文件名" + (validated.prefix ? "" : "（桶根目录）"),
      "寻址：" + (validated.forcePathStyle ? "Path style" : "Virtual hosted"),
      "凭据：已设置（隐藏）" + (validated.sessionToken ? "，含临时 Token（需自行续期）" : ""),
      "单文件上限：" + validated.maxBytes / MIB + " MiB",
      "下载有效期：" + validated.expireHours + " 小时（仅授权 GET 下载）",
      "计划删除：链接到期后再保留 " + validated.cleanupGraceMinutes + " 分钟；后台扫描删除，失败重试",
    ].join("\n"), "保存预览");
  }
  const nextBackend = config ? relayBackendId(validateRelayConfig(config)) : null;
  const stranded = checkLedger(config !== null).filter(entry => !nextBackend || !entry.key.startsWith(nextBackend + ":"));
  if (stranded.length) log.warn(`账本仍有 ${stranded.length} 个对象不属于新设置；切换或停用后无法自动删除这些对象。` +
    "建议取消，先在原设置下执行「数据 → 外链 → 清理全部外链」（命令行 relay-purge）；也可保存后在云端清理，或切回原设置再清理。");
  if (!bail<boolean>(await confirm({ message: "保存并应用以上外链设置？", initialValue: action !== "disable" }))) {
    throw new DOMException("配置已取消", "AbortError");
  }
  await mkdir(dirname(draftPath), { recursive: true });
  await writeFile(draftPath, JSON.stringify({ expectedHash: fingerprint(raw), config }) + "\n", { mode: 0o600, flag: "wx" });
  outro("配置已确认，正在应用。");
}

async function apply(draftPath: string): Promise<void> {
  let draft: { expectedHash: string | null; config: Record<string, unknown> | null };
  try { draft = JSON.parse(await readFile(draftPath, "utf8")); }
  catch { throw new Error("外链配置草稿无法读取，请重新打开配置向导"); }
  if (!draft || (draft.expectedHash !== null && !/^[a-f0-9]{64}$/.test(draft.expectedHash)) ||
      !(draft.config === null || (typeof draft.config === "object" && !Array.isArray(draft.config)))) {
    throw new Error("外链配置草稿无效，请重新打开配置向导");
  }
  if (draft.config !== null) validateRelayConfig(draft.config);
  await withMaintenance(async () => {
    if (fingerprint(await currentFile()) !== draft.expectedHash) {
      throw new Error("relay.json 已被其他操作修改，请重新打开配置向导；本次未覆盖配置");
    }
    if (draft.config === null) {
      await archiveFile(RELAY_CONFIG_PATH);
      console.log("外链已停用，原配置已归档到 backup/rm；远端文件和账本已保留。");
      return;
    }
    // Recheck under the service lease: the ledger may have changed since the draft was confirmed.
    checkLedger(true);
    await mkdir(dirname(RELAY_CONFIG_PATH), { recursive: true });
    const temporary = join(dirname(RELAY_CONFIG_PATH), ".relay-" + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, JSON.stringify(draft.config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      // sudo 下配置时保持原运行用户可读，避免 root 创建的 0600 文件阻止容器启动。
      if (process.platform !== "win32") {
        const owner = await stat(RELAY_CONFIG_PATH).catch(error => {
          if (error.code === "ENOENT") return stat(dirname(RELAY_CONFIG_PATH));
          throw error;
        });
        await chown(temporary, owner.uid, owner.gid);
      }
      await replaceFile(temporary, RELAY_CONFIG_PATH);
    } finally { await rm(temporary, { force: true }); }
    console.log("外链配置已保存到 " + RELAY_CONFIG_PATH);
    console.log("云端权限或设置有变化时，请在「数据 → 外链 → 测试外链」（命令行 relay-test）上传测试文件验收。");
  });
}

if (import.meta.main) {
  try {
    const [mode, path, extra] = process.argv.slice(2);
    if (!path || extra || !["--draft", "--apply"].includes(mode ?? "")) {
      throw new Error("请从 TUI 的「系统 → 设置 → 外链配置」进入配置向导");
    }
    if (mode === "--draft") await prepare(path);
    else await apply(path);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") cancel("已取消，配置和服务保持原状。");
    else { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}

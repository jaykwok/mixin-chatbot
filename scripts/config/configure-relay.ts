#!/usr/bin/env bun
// 先交互形成草稿，运维脚本再停机并提交；填写和取消都不影响运行中的机器人。
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, text } from "@clack/prompts";
import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../../src/core/config.ts";
import { archiveFile, replaceFile, withMaintenance } from "../../src/core/maintenance.ts";
import { RELAY_CONFIG_PATH } from "../../src/core/storage.ts";
import { DEFAULT_RELAY_MAX_BYTES, validateRelayConfig, type RelayConfig } from "../../src/integrations/relay.ts";
import { normalizeRelayUrlInput } from "./relay-url.ts";

const MIB = 1024 ** 2;
const CONFIG_FIELDS = ["webdavUrl", "publicBaseUrl", "username", "password", "maxBytes", "expireHours", "signSecret", "signPathPrefix"];

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

function requireUrl(value: string | undefined, kind: "webdav" | "public", webdavUrl?: string): string | undefined {
  try { normalizeRelayUrlInput(value, kind, webdavUrl); }
  catch (error) { return error instanceof Error ? error.message : "请输入有效的目录地址"; }
}

async function askUrl(message: string, previous: string, kind: "webdav" | "public", webdavUrl?: string): Promise<string> {
  const initial = requireUrl(previous, kind, webdavUrl) ? "" : normalizeRelayUrlInput(previous, kind, webdavUrl);
  return normalizeRelayUrlInput(await askText(message, initial, value => requireUrl(value, kind, webdavUrl)), kind, webdavUrl);
}

async function askText(message: string, initialValue: string, validate?: (value: string | undefined) => string | undefined): Promise<string> {
  return bail<string>(await text({ message, initialValue, defaultValue: initialValue, validate })).trim();
}

async function askSecret(label: string, previous?: string): Promise<string> {
  const value = bail<string>(await password({
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

async function prepare(draftPath: string): Promise<void> {
  intro("可选的大文件外链配置");
  note("超过 25 MiB 的本地文件可上传到 WebDAV，再向群里发送下载链接。\n" +
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
      "1) 在 Alist 挂载可写存储，示例挂载路径为 /relay，账号基本路径为 /。",
      "   账号需有 WebDAV 读取、管理、创建目录或上传、删除权限。",
      "2) 将 example.com 的 DNS 接入 Cloudflare 并激活；在隧道 Published application 新增",
      "   files.example.com，服务指向 http://127.0.0.1:5244（Alist 所在地址）。",
      "   5244 仅为示例，隧道和上传地址均请填写 Alist 实际端口；源站地址须从连接器可达。",
      "3) 填写上传目录，再填写公开下载域名：",
      "   WebDAV 上传：http://127.0.0.1:5244/dav/relay/",
      "   公开下载填 files.example.com，自动补成 https://files.example.com/d/relay/",
      "上传地址填写到 Alist 挂载目录，例如 127.0.0.1:5244/dav/relay，",
      "此处挂载目录为 relay；请替换为实际挂载目录，也可填写挂载内的子目录。",
      "只填目录，不带日期子目录和文件名。127.0.0.1 适用于机器人与 Alist 可在本机互访；",
      "公开下载填写接收者能访问的域名。DNS 和隧道路由需在 Cloudflare 控制台配置。",
    ].join("\n"), "Alist + Cloudflare 子域名示例");
    note("http://、https:// 和末尾 / 均可省略，保存前会显示完整地址。\n" +
      "WebDAV 的 localhost、回环及私有 IP 默认补 http://；其他地址（含公开下载）默认补 https://。\n" +
      "上传地址需包含 /dav/ 和挂载目录；公开下载只填域名时，由上传地址推导 /d/ 下的目录。\n" +
      "显式填写的协议和下载目录会保留；其他 WebDAV 后端请填写完整公开下载地址。", "地址填写方式");
    const next: RelayConfig = { ...(previous ?? { maxBytes: DEFAULT_RELAY_MAX_BYTES, webdavUrl: "", publicBaseUrl: "" }) };
    next.webdavUrl = await askUrl("WebDAV 上传目录 URL（填写到 Alist 挂载目录）", next.webdavUrl, "webdav");
    next.publicBaseUrl = await askUrl("公开下载目录 URL（Alist 可只填域名，如 files.example.com；也可填完整目录地址）",
      next.publicBaseUrl, "public", next.webdavUrl);
    const auth = bail<string>(await select({
      message: "WebDAV 认证方式", initialValue: previous?.username !== undefined ? "basic" : "none",
      options: [{ value: "basic", label: "用户名和密码" }, { value: "none", label: "无需认证" }],
    }));
    if (auth === "basic") {
      next.username = await askText("WebDAV 用户名", previous?.username ?? "", value => value?.trim() ? undefined : "不能为空");
      const sameAccount = previous?.username === next.username && !requireUrl(previous?.webdavUrl, "webdav") &&
        normalizeRelayUrlInput(previous?.webdavUrl, "webdav") === next.webdavUrl;
      next.password = await askSecret("WebDAV 密码", sameAccount ? previous?.password : undefined);
    } else {
      delete next.username;
      delete next.password;
    }
    const advanced = bail<boolean>(await confirm({
      message: "调整高级设置（文件上限、有效期、下载签名）？", initialValue: false,
    }));
    if (advanced) {
      const limit = await askText("单文件外链上限（MiB，须大于 " + MAX_ATTACHMENT_BYTES / MIB + "）",
        String(next.maxBytes / MIB), value => validationError({ ...next, maxBytes: Number(value) * MIB }));
      next.maxBytes = Number(limit) * MIB;
      const expiry = await askText("链接有效期（小时，留空表示不自动过期）", next.expireHours?.toString() ?? "",
        value => validationError({ ...next, expireHours: value?.trim() ? Number(value) : undefined }));
      if (expiry) next.expireHours = Number(expiry); else delete next.expireHours;
      const signing = bail<string>(await select({
        message: "公开下载签名", initialValue: next.signSecret ? "alist" : "none",
        options: [
          { value: "none", label: "不使用签名", hint: "通用 WebDAV；设置有效期后，到期会删除远端文件" },
          { value: "alist", label: "Alist / OpenList 兼容签名", hint: "后端须支持并开启相同签名规则；到期只让链接失效" },
        ],
      }));
      if (signing === "alist") {
        next.signSecret = await askSecret("下载签名密钥", previous?.signSecret);
        const prefix = await askText("签名路径前缀（如 /relay/；留空从公开 URL 推导）", previous?.signPathPrefix ?? "",
          value => validationError({ ...next, signPathPrefix: value?.trim() || undefined }));
        if (prefix) next.signPathPrefix = prefix; else delete next.signPathPrefix;
      } else {
        delete next.signSecret;
        delete next.signPathPrefix;
      }
    }
    const validated = validateRelayConfig(next);
    // 向导未涉及的手写字段保留；明确关闭的可选项不会从旧配置重新带回来。
    config = { ...fields };
    for (const field of CONFIG_FIELDS) delete config[field];
    Object.assign(config, validated);
    const expiryDescription = validated.expireHours === undefined
      ? "不自动过期"
      : validated.signSecret
        ? validated.expireHours + " 小时后签名失效，远端文件保留"
        : validated.expireHours + " 小时后删除远端文件（不可恢复）";
    note([
      "上传目录：" + displayUrl(validated.webdavUrl),
      "公开目录：" + displayUrl(validated.publicBaseUrl),
      "认证：" + (validated.username === undefined ? "无需认证" : "已设置用户名和密码（密码隐藏）"),
      "单文件上限：" + validated.maxBytes / MIB + " MiB",
      "有效期：" + expiryDescription,
      "下载签名：" + (validated.signSecret ? "已设置（密钥隐藏），路径 " + validated.signPathPrefix : "未启用"),
    ].join("\n"), "保存预览");
  }
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

import type { AdvancedRuntimeKey } from "../../../src/core/runtime-schema.ts";

export interface RuntimeOption {
  key: AdvancedRuntimeKey;
  label: string;
  description: string;
  unit?: string;
  choices?: { value: string; label: string }[];
  /** Shown for the empty default; a blank answer restores it. */
  empty?: string;
}
export const RUNTIME_GROUPS: { label: string; description: string; options: RuntimeOption[] }[] = [
  { label: "并发与附件", description: "请求数量与附件上传并发", options: [
    { key: "BOT_MAX_ACTIVE_REQUESTS", label: "请求并发上限", description: "已接收但尚未完成清理的普通请求总数；超限时提示稍后重试。" },
    { key: "BOT_ATTACHMENT_CONCURRENCY", label: "附件并发", description: "同时读取、上传小附件的数量，用于控制内存峰值。" },
  ] },
  { label: "收到提示", description: "提问后先回一句“收到，正在处理”", options: [
    { key: "BOT_ACKNOWLEDGE_IDLE_MINUTES", label: "收到提示间隔", unit: "分钟", description: "单聊：成员第一次提问，或超过这段时间没有对话后的第一条提问，先回一句“收到，正在处理”。群聊：回过这句后，这段时间内群里任何人的提问都不再回。0 表示关闭，最长 1440 分钟。应用后重启生效。" },
  ] },
  { label: "超时与退出", description: "整轮、模型、工具、交付及关机时限", options: [
    { key: "BOT_RUN_TIMEOUT_SECONDS", label: "整轮处理时限", unit: "秒", description: "覆盖准备、模型、工具与最终交付；其他时限仍受整轮剩余时间约束。" },
    { key: "BOT_CLOSEOUT_SECONDS", label: "提前收尾", unit: "秒", description: "剩余此时间进入收尾；须小于整轮时限一半。" },
    { key: "BOT_DELIVERY_RESERVE_SECONDS", label: "交付保留", unit: "秒", description: "最后这段时间只允许读取、登记、发送；须小于收尾时间。" },
    { key: "BOT_FALLBACK_SEND_SECONDS", label: "失败兜底发送预算", unit: "秒", description: "任务失败时兜底发送的时限；到期后没发出的内容不再重试。" },
    { key: "BOT_MODEL_IDLE_TIMEOUT_SECONDS", label: "模型无进展时限", unit: "秒", description: "模型等待或输出期间，连续没有有效进展的上限。" },
    { key: "BOT_MODEL_RESPONSE_TIMEOUT_SECONDS", label: "单次模型响应时限", unit: "秒", description: "包含首字等待；持续输出也不会延长此时限。" },
    { key: "BOT_BASH_TIMEOUT", label: "命令默认时限", unit: "秒", description: "模型未指定时使用；工具可声明其他时限，最高 3600 秒。" },
    { key: "BOT_SHUTDOWN_TIMEOUT_SECONDS", label: "关机收尾时限", unit: "秒", description: "覆盖 HTTP、任务、子进程与租约收尾。" },
  ] },
  { label: "缓存与索引", description: "资料索引容量、刷新与模型缓存策略", options: [
    { key: "BOT_INDEX_TTL_MINUTES", label: "索引刷新间隔", unit: "分钟", description: "活跃会话每轮检查；首次等待构建，过期后后台刷新。" },
    { key: "BOT_INDEX_MAX_FILES", label: "索引文件上限", description: "单次扫描收录的文件数，防止过大的目录树占满资源。" },
    { key: "BOT_INDEX_MAX_DEPTH", label: "索引目录深度", description: "超过此深度的目录会跳过，索引标记为不完整。" },
    { key: "PI_CACHE_RETENTION", label: "模型缓存保留", description: "Pi 原生的服务端缓存保留期限，由支持缓存的服务商决定实际期限和收益；Pi 设置里的 durable.stream.cacheRetention 优先。", choices: [
      { value: "short", label: "短期（默认）" }, { value: "long", label: "长期" },
    ] },
  ] },
  { label: "文档处理", description: "文档加工模块、解析环境、默认模板与 LibreOffice", options: [
    { key: "BOT_DOCUMENT_WORK_ENABLED", label: "文档加工模块", description: "统一启停文档 skill、编辑/组装/渲染工具及其提示词；基础检索、解析和原文件发送仍可用。应用后重启生效。", choices: [
      { value: "1", label: "开启" }, { value: "0", label: "关闭" },
    ] },
    { key: "BOT_DOCUMENT_ENV", label: "共享文档环境覆盖", empty: "data/runtime/document-env", description: "留空时全部单聊和群共用 data/runtime/document-env，首次使用时由 uv 按需准备。填写路径则改用指定的现成环境；通常保持默认。Linux 填容器内路径；隔离任务使用镜像内的环境。" },
    { key: "BOT_DOCUMENT_PPTX_TEMPLATE", label: "默认 PPT 模板", empty: "内置版式", description: "生成 PPT 未指定模板时套用，支持 .pptx/.potx。相对路径在共享资料中查找，找不到时用内置版式；绝对路径按服务看到的路径，Linux 填容器内路径。应用后重启生效。" },
    { key: "BOT_DOCUMENT_DOCX_TEMPLATE", label: "默认 Word 模板", empty: "内置版式", description: "生成 Word 未指定模板时套用，支持 .docx/.dotx。相对路径在共享资料中查找，找不到时用内置版式；绝对路径按服务看到的路径，Linux 填容器内路径。应用后重启生效。" },
    { key: "BOT_DOCUMENT_OFFICE_PATH", label: "LibreOffice 程序路径", empty: "自动查找", description: "Word/PPT 预览和页面截图使用。填程序的绝对路径，例如 C:/Program Files/LibreOffice/program/soffice.exe 或 /usr/bin/soffice，不填目录、引号或参数。Linux 隔离任务填任务容器内路径。留空先查 PATH，Windows 再查标准安装目录；指定路径无效时会报错。应用后重启生效。" },
  ] },
];

const OPTIONS = new Map(RUNTIME_GROUPS.flatMap(group => group.options).map(option => [option.key as string, option]));
export const runtimeOption = (key: string): RuntimeOption | undefined => OPTIONS.get(key);
/** Validation messages name a setting by its key; pages name it as the form does. */
export const withRuntimeLabels = (text: string): string =>
  text.replace(/\b((?:BOT|PI)_[A-Z0-9_]+)\b ?/g, (match, key: string) => { const option = OPTIONS.get(key); return option ? `「${option.label}」` : match; });

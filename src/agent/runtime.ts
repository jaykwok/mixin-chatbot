// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// 纯适配——只用 Pi 公开 API：
//   - provider/model/key 由 data/config/models.json 承载，Pi 原生读取（ModelRuntime.create({modelsPath})）
//   - read/bash/edit/write 复用 Pi 官方工具工厂，同名覆盖只增加路径边界和用户临时环境；
//     cwd 绑定到 <GROUP_DATA_ROOT>/<group>/workspace，临时文件写当前用户的 users/<phone>/tmp
//   - 发送工具 send_image/send_file 经 customTools（ToolDefinition）注册，定义在 ./send-tools.ts
//   - system prompt 用 Pi 默认 + appendSystemPromptOverride 追加群聊岗位上下文（方便上游升级）；
//     追加内容按当前资料索引与文档解析环境的就绪状态生成，不对模型宣称不存在的东西已备好
// 会话持久化到 <GROUP_DATA_ROOT>/<group>/users/<phone>/session.jsonl。
//
// workspace 是外部同步盘的镜像、只放资料，所以本适配层自己需要的东西都在它外面、与它
// 平级：<group>/index/ 放可 grep 的资料清单，<group>/venv/ 放文档解析用的 Python 环境。
//
// 中途干预（Pi 官方 API）：
//   - agent 正忙时，普通消息 → session.steer()（等当前这批工具调用完、下次调 LLM 前注入，软干预）
//   - /stop → session.abort()（硬中断，经 AbortSignal 连带取消在跑的工具）
//     + session.clearQueue()（abort 只结束这一轮，排队中的干预要一起丢）
//   - /status /clear /help → 状态查询、清会话、帮助
import { readFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  formatSize,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DOCUMENT_TOOLCHAIN_PACKAGES,
  GROUP_DATA_ROOT,
  MAX_ATTACHMENT_BYTES,
  SESSION_IDLE_TTL,
} from "../core/config.ts";
import { log } from "../core/log.ts";
import {
  MODELS_JSON_PATH,
  MODELS_STORE_PATH,
  PI_AGENT_DIR,
  RUNTIME_DIR,
} from "../core/storage.ts";
import {
  abortOutboundRequests,
  getOutboundRateStatus,
  sendReplyWithMention,
  sendText,
} from "../integrations/im.ts";
import { getRelayConfig } from "../integrations/relay.ts";
import {
  groupIndexDir,
  groupVenvDir,
  groupWorkspaceDir,
  materialsIgnorePath,
  materialsIndexPath,
  sessionFilePath,
  userTempDir,
} from "./paths.ts";
import {
  ensureMaterialsIndex,
  type MaterialsIndexSummary,
} from "./materials-index.ts";
import {
  documentToolchainReady,
  ensureDocumentToolchain,
} from "./python-toolchain.ts";
import {
  canonicalCommand,
  HELP_TEXT,
  isSlashCommandMessage,
  stripLeadingMention,
  unknownCommandText,
} from "./commands.ts";
import { buildLocalTools } from "./local-tools.ts";
import {
  buildSendTools,
  createOutboundNotes,
  type OutboundNotes,
} from "./send-tools.ts";
import { createSystemPromptTrimExtension } from "./system-prompt-trim.ts";
import {
  consumeTerminalToolBlockReply,
  createToolPolicyExtension,
  type TerminalToolBlockState,
} from "./tool-policy.ts";
import { getWorkspaceCoordinationStatus } from "./workspace-coordinator.ts";

// ModelRuntime 单例 + 解析出的单模型。从 data/config/models.json 加载（Pi 原生）。
let modelRuntime: ModelRuntime | null = null;
let resolvedModel: Model<Api> | null = null;
let resolvedThinkingLevel: ModelThinkingLevel = "off";
type RuntimeSelection = {
  runtime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
};
let runtimePromise: Promise<RuntimeSelection> | null = null;

async function getRuntime(): Promise<RuntimeSelection> {
  if (modelRuntime && resolvedModel) {
    return {
      runtime: modelRuntime,
      model: resolvedModel,
      thinkingLevel: resolvedThinkingLevel,
    };
  }
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 显式读 models.json 拿声明的 provider/model id（getProviders() 会混入内置 provider）。
    let providerId: string | undefined;
    let modelId: string | undefined;
    let configuredThinkingLevel: ModelThinkingLevel = "off";
    try {
      const raw = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8")) as {
        thinkingLevel?: ModelThinkingLevel;
        providers?: Record<string, { models?: { id?: string }[] }>;
      };
      providerId = Object.keys(raw.providers ?? {})[0];
      modelId = raw.providers?.[providerId]?.models?.[0]?.id;
      configuredThinkingLevel = raw.thinkingLevel ?? "off";
    } catch {
      throw new Error(
        `无法读取 ${MODELS_JSON_PATH}。请先生成 AI 配置：运行 bun run configure（部署脚本会自动调用）`
      );
    }
    if (!providerId || !modelId) {
      throw new Error(`${MODELS_JSON_PATH} 未声明 provider/model，请重新运行 configure 工具。`);
    }

    // Pi 默认把模型目录缓存写在 models.json 旁边；显式指向 data/runtime，让
    // data/config 里只剩用户真正要维护的东西。首次写入前目录必须存在。
    await mkdir(RUNTIME_DIR, { recursive: true });
    const runtime = await ModelRuntime.create({
      modelsPath: MODELS_JSON_PATH,
      modelsStorePath: MODELS_STORE_PATH,
    });
    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      throw new Error(`${MODELS_JSON_PATH} 中未找到 ${providerId}/${modelId}，请检查配置。`);
    }
    const auth = await runtime.checkAuth(providerId);
    if (!auth) {
      throw new Error(
        `${MODELS_JSON_PATH} 中的 provider ${providerId} 未配置可用凭证，请重新运行 configure 工具。`
      );
    }
    const thinkingLevel = clampThinkingLevel(model, configuredThinkingLevel);
    modelRuntime = runtime;
    resolvedModel = model;
    resolvedThinkingLevel = thinkingLevel;
    log.info(
      `Pi ModelRuntime 就绪（provider=${providerId}, model=${modelId}, thinkingLevel=${thinkingLevel}, 群数据总根=${GROUP_DATA_ROOT}）`
    );
    return { runtime, model, thinkingLevel };
  })();

  try {
    return await runtimePromise;
  } catch (e) {
    runtimePromise = null;
    throw e;
  }
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ClearResult = { ok: true } | { ok: false; message: string };

// 每 (群, phone) 一个 AgentSession；不同用户可并发，workspace 写入由工具层按文件协调。
const sessions = new Map<string, AgentSession>();
// 避免同一群/用户的并发首条消息重复创建两个 session 并同时写一个 jsonl。
const sessionCreations = new Map<string, Promise<AgentSession>>();
// dispose 期间阻止同一会话立刻重开并与旧实例同时操作同一个 jsonl。
const sessionDisposals = new Map<string, Promise<void>>();
// /clear 的 abort、dispose、删除历史必须整体完成后，才能为同一用户重建 session。
const sessionClears = new Map<string, Promise<ClearResult>>();
const sessionLastUsed = new Map<string, number>();
// 平台可能轮换 callback key；发送工具在每次执行时读取当前会话最新 URL。
const sessionCallbackUrls = new Map<string, string>();
// 正在跑 prompt 的 session（中途来的消息走 steer；同一 session 同时只允许一个 prompt）。
const busySessions = new WeakSet<AgentSession>();
// 被指令（/stop /clear）主动中断的 session——其 in-flight prompt 不再发回复/错误（指令已自己回执）。
const abortingSessions = new WeakSet<AgentSession>();
// 让 /clear 与进程关闭能等 runPrompt 的外围发送/清理逻辑真正结束。
const activeRuns = new Map<AgentSession, Promise<void>>();
// /stop 与 /clear 同时取消适配层自己的状态/最终回复发送，不只中断 Pi prompt。
const runOutboundControllers = new WeakMap<AgentSession, AbortController>();
// 每个session最近一次工具调用摘要，供 /status 展示。
const lastTool = new WeakMap<AgentSession, string>();
// 0.84.1：全终止 tool_call 批次不会再调用模型，直接把策略原因回复给用户。
const terminalToolBlockStates = new WeakMap<
  AgentSession,
  TerminalToolBlockState
>();
// 工具产出的、必须原样进群的文本（目前只有大文件外链）。每个 session 一份；同一 session
// 的 run 是串行的（busySessions 保证），所以不会串台。
const sessionOutboundNotes = new WeakMap<AgentSession, OutboundNotes>();
let acceptingRequests = true;

/** 提示词里列出的顶层目录条数上限；再多就用「等」收尾，避免概览喧宾夺主。 */
const INDEX_OVERVIEW_LIMIT = 12;

/**
 * 资料检索段落：有索引就指向索引，没有就老老实实退回目录遍历。
 *
 * 这里刻意**不写文件总数、也不写每个目录下的文件数**，尽管手里就有。原因是缓存：
 * 请求的结构是 [system prompt][历史消息…]，前缀缓存按最长公共前缀匹配，system prompt
 * 变一个字符，后面整段历史就全部要按全价重新计费。而 buildChatContext 是建会话时算
 * 一次的，会话空闲 30 分钟即释放，群聊又是突发式的——同一个人隔天回来就是一次重建。
 * 只要同步盘期间多进来一个文件，带数字的这两行就会变，几万 token 的历史缓存随之作废。
 * 这些数字对模型没有用处（清单文件头部本来就有，模型真正用的是 grep），不值得拿缓存换。
 * 顶层目录名同理只留名字：名字很少变，数量天天变。
 */
function buildIndexSection(index: MaterialsIndexSummary | null): string {
  if (!index || index.totalFiles === 0) {
    return `本群暂时没有可用的资料清单，用 find -iname 按关键词定位文件，先缩小到相关子目录再逐层展开。`;
  }
  const shown = index.topLevel.slice(0, INDEX_OVERVIEW_LIMIT);
  const overview = shown.map((dir) => dir.name).join("、");
  const suffix = index.topLevel.length > shown.length ? " 等" : "";
  const lines = [
    `资料清单在 $PI_MATERIALS_INDEX（${index.path.replace(/\\/g, "/")}），每行一个文件，格式为 \`相对路径 | 大小 | 修改日期\`，路径相对于资料库根目录；开头几行有文件总数和生成时间。`,
    `找材料先 grep 这份清单定位，命中不了再用 find 兜底；不要整份读取清单，也不要一上来就遍历目录树。`,
    `顶层目录：${overview}${suffix}。`,
    `清单每隔几分钟重建一次，可能略滞后于同步盘；用户说刚放进来的文件在清单里找不到时，直接去目录里找。`,
  ];
  if (index.truncated) {
    lines.push(`清单因文件过多被截断，未收录的部分需要用 find 自行定位。`);
  }
  return lines.join("\n");
}

/** Python 段落：环境备好与否决定措辞，不能对模型说不存在的东西已经装好。 */
function buildPythonSection(ready: boolean): string {
  const packages = DOCUMENT_TOOLCHAIN_PACKAGES.join("、");
  if (ready) {
    return `解析环境已备好：解释器路径在 $PI_PYTHON，${packages} 均已安装，直接用 "$PI_PYTHON" 运行脚本，不要另建虚拟环境、不要重装依赖、也不要去探测 python/python3 在哪。确需额外的包时用 uv pip install --python "$PI_PYTHON" <包名>。`;
  }
  return `解析环境尚未就绪：用 uv venv "$VIRTUAL_ENV" 创建，再用 uv pip install --python "$PI_PYTHON" ${DOCUMENT_TOOLCHAIN_PACKAGES.join(" ")} 装依赖，之后统一用 "$PI_PYTHON" 运行。环境必须建在 $VIRTUAL_ENV，不要建在资料库里，也不要建在临时目录里。`;
}

/**
 * 追加到 Pi 默认 system prompt 的群聊上下文。
 *
 * Pi 的默认 prompt 把模型定位成 coding assistant，这里要把它拉回真正的岗位：依据群资料
 * 答问、发原始材料、按资料做交付物。内容按「岗位 → 资料在哪 → 怎么读 → 怎么发 → 环境
 * 约束」排列，把最常用的判断放在最前面。
 *
 * 唯一的例外是排在最后的「临时目录」：它是整段里仅有的按用户变化的内容（其余对全群
 * 逐字相同）。放到末尾，前面所有段落在群成员之间就是同一串前缀，跨会话的前缀缓存能多
 * 覆盖一点。收益不大——历史消息排在 system prompt 之后，用户之间本来就无从共享——但
 * 代价为零，而这一段本来就是查阅性质的，放末尾不影响阅读。
 */
export function buildChatContext(options: {
  tempDir: string;
  index: MaterialsIndexSummary | null;
  pythonReady: boolean;
}): string {
  return `## 角色
你是「量子密信」群里的产品资料助手，服务群里的销售与售前同事。三类高频任务：
① 依据本群资料回答产品、价格、参数、政策问题；
② 把群成员点名要的原始材料直接发到群里；
③ 依据资料整理方案、报价、对比、话术、清单等交付物并发出。
用中文简洁回复；需要标题、强调、列表、链接、表格或代码时使用 Markdown，普通段落不必添加格式。回复会自动发到群里。
你与每位用户是各自独立的会话，看不到其他人问过什么。用户提到「刚才那份」「上面那个」而你的上下文里没有时，请他补充说明，不要猜。

## 资料库
当前工作目录就是本群资料库，bash 启动时已经在该目录，直接用相对路径，不要在每条命令里 cd 到绝对路径。
它由外部同步盘镜像而来，按约定只存放资料：把它当只读的资料库，不要往里写任何东西——写进去的文件会污染同步源，并可能被下一次同步删除。
${buildIndexSection(options.index)}
文件名多为中文并带版本号或日期；命中多份时取最新的一版，并在回复里说明用的是哪一版。
你之前轮次里的检索结果和提取内容都只是当时的快照，而资料随时会被同步更新：回答价格、参数、版本或再次发送文件之前，重新查一遍当前资料，不要直接引用历史里的结论。
安全、量子产品及项目知识一律以这些资料为准。资料里没有就直接说没有、并说明查过哪些位置，绝不用通用知识补价格、参数、折扣或政策。回答中注明依据的文件名，必要时给出第几页或哪个 sheet。

## 读文档
.pptx/.docx/.xlsx/.pdf 都是二进制文件，read 工具读出来是乱码，不要对它们用 read，也不要 cat。统一用 Python 提取文本。
${buildPythonSection(options.pythonReady)}
先把提取结果写成文本文件放进你的临时目录，再用 grep 或关键词定位需要的段落。不要把整份文档打印到终端——上下文有限，一次转储就可能把整轮会话挤爆。
旧格式 .doc/.xls 和扫描版 PDF 可能提不出文字；提不出就如实说明该文件无法解析，不要猜内容。

## 发文件与交付物
用户要「原始材料/手册/PPT」时，直接 send_file 发资料库里的原文件，不做格式转换、不压缩、不重新生成；只有用户明确要求换格式时才转换。
超过 ${formatSize(MAX_ATTACHMENT_BYTES)} 的文件照常调用 send_file，系统会自动改为发送下载链接，不要自己压缩或拆分。
你生成的交付物写进临时目录再 send_file，不要写进资料库。需要出 Excel、算表或处理图片时，仍用上面「读文档」里那个 "$PI_PYTHON" 环境，不要另建。
群里的文字回复结论先行、控制在十几行内；细节多的内容做成文件发送，不要把长文档整段贴进群。发完文件只说发了什么、出自哪份资料，不必复述文件内容。

## 并发与写入
不同用户的任务可以同时运行。read 可直接并行；edit/write 会自动按目标文件协调，同一个文件的写入按 FIFO 执行，不同文件可并行。
调用 bash 时，mutates 用于排队协调，请列出命令可能创建、修改、重命名或删除的每个路径；纯读取命令填空数组，无法列清或会批量修改时填 ["."]。临时目录内的路径不需要协调，列进去也会被忽略，不必为此改写命令。禁止启动退出工具后仍会继续写文件的后台进程。

## 干预
干活途中用户可能插话干预（steer），请把后续用户消息当作对当前任务的补充或纠正，及时调整方向。

## 临时目录
当前调用用户的专属临时目录是：${resolve(options.tempDir)}（也可读环境变量 $PI_USER_TMP）。
下载、缓存、解压、提取产物、草稿和其他中间文件必须放进该目录；不要放进资料库、系统临时目录、其他用户目录或上级目录。
bash 已把 TMPDIR、TMP、TEMP 和常见包管理器缓存指向该目录，中文编码也已配好（PYTHONUTF8、LANG），不必再自己设置编码或代码页。命令若有独立的缓存或输出参数，也要显式指向该目录。
仅当任务确实需要定位会话或调用者时，才使用 PI_CALLER_PHONE、PI_GROUP_ID，不要主动枚举或检查环境变量。`;
}

/**
 * 为已存在的群预热文档解析环境与资料索引。
 *
 * 两者都是「建一次、用很久」的东西，但都只在建会话时才被发现缺失。会话缓存有 30 分钟
 * 空闲期，不预热的话每次重启后的头几十分钟里，先来的用户会拿到降级提示词、并等一次
 * 全量扫描。启动时顺手补上，代价只是后台多跑一遍。
 */
async function warmExistingGroups(): Promise<void> {
  let entries;
  try {
    entries = await readdir(GROUP_DATA_ROOT, { withFileTypes: true });
  } catch {
    return; // 还没有任何群，等第一条消息自然创建。
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 目录名就是 groupSegment 的输出，而 groupSegment 对自身的输出是幂等的。
    const groupId = entry.name;
    const workspace = resolve(groupWorkspaceDir(GROUP_DATA_ROOT, groupId));
    try {
      if (!(await stat(workspace)).isDirectory()) continue;
    } catch {
      continue;
    }
    void ensureDocumentToolchain(resolve(groupVenvDir(GROUP_DATA_ROOT, groupId)));
    const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, groupId));
    await mkdir(dirname(indexPath), { recursive: true });
    void ensureMaterialsIndex({
      workspaceDir: workspace,
      indexPath,
      ignorePath: resolve(materialsIgnorePath(GROUP_DATA_ROOT, groupId)),
    });
  }
}

/** 在开放 HTTP 端口前验证 models.json 与目标模型确实可加载。 */
export async function initializeAgentRuntime(): Promise<void> {
  await getRuntime();
  // 预热不参与启动成败：装包要联网、扫描要遍历同步盘，都不该拖住端口开放。
  void warmExistingGroups().catch((e) =>
    log.warn(`群资源预热失败 - ${String(e)}`)
  );
}

function sessionKey(phone: string, groupId: string): string {
  return JSON.stringify([groupId, phone]);
}

/** 后台错误回执也使用会话最近一次收到的 callback URL。 */
export function resolveSessionCallbackUrl(
  phone: string,
  groupId: string,
  fallback: string
): string {
  return sessionCallbackUrls.get(sessionKey(phone, groupId)) ?? fallback;
}

async function disposeSession(key: string, session: AgentSession): Promise<void> {
  const existing = sessionDisposals.get(key);
  if (existing) return existing;
  const disposal = (async () => {
    try {
      await session.dispose();
    } catch (e) {
      log.error(`session dispose 失败 - 会话: ${key}, 错误: ${String(e)}`);
    }
  })();
  sessionDisposals.set(key, disposal);
  try {
    await disposal;
  } finally {
    if (sessionDisposals.get(key) === disposal) sessionDisposals.delete(key);
  }
}

/** 释放长期空闲的内存 session；jsonl 历史保留，下次消息会自动重开。 */
export async function cleanupIdleSessions(now = Date.now()): Promise<void> {
  for (const [key, session] of sessions) {
    const lastUsed = sessionLastUsed.get(key) ?? now;
    if (busySessions.has(session) || now - lastUsed < SESSION_IDLE_TTL) continue;
    sessions.delete(key);
    sessionLastUsed.delete(key);
    sessionCallbackUrls.delete(key);
    lastTool.delete(session);
    await disposeSession(key, session);
    log.info(`已释放空闲会话缓存 - 会话: ${key}`);
  }
}

async function createSession(
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<AgentSession> {
  const key = sessionKey(phone, groupId);
  const { runtime, model, thinkingLevel } = await getRuntime();
  const cwd = resolve(groupWorkspaceDir(GROUP_DATA_ROOT, groupId));
  const tempDir = resolve(userTempDir(GROUP_DATA_ROOT, groupId, phone));
  const historyPath = resolve(sessionFilePath(GROUP_DATA_ROOT, groupId, phone));
  const piAgentDir = resolve(PI_AGENT_DIR);
  // 索引与 venv 与 workspace 平级：workspace 是同步盘镜像，只放资料。
  const indexDir = resolve(groupIndexDir(GROUP_DATA_ROOT, groupId));
  const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, groupId));
  const venvDir = resolve(groupVenvDir(GROUP_DATA_ROOT, groupId));
  await mkdir(cwd, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(dirname(historyPath), { recursive: true });
  await mkdir(piAgentDir, { recursive: true });
  await mkdir(indexDir, { recursive: true });
  // 建环境要联网装包，可能几十秒；这里只查当前状态、后台补齐，不能让用户在收到
  // 「正在思考」之前先干等一次 pip 安装。
  const pythonReady = await documentToolchainReady(venvDir);
  if (!pythonReady) void ensureDocumentToolchain(venvDir);
  const index = await ensureMaterialsIndex({
    workspaceDir: cwd,
    indexPath,
    ignorePath: resolve(materialsIgnorePath(GROUP_DATA_ROOT, groupId)),
  });
  const sessionManager = SessionManager.open(historyPath);
  const settingsManager = SettingsManager.inMemory();
  const toolPolicy = createToolPolicyExtension();
  const resourceLoader = new DefaultResourceLoader({
    cwd, // 群共享工作目录（<group>/workspace/）
    agentDir: piAgentDir, // 可重建的共享 Pi 内部目录，避免污染仓库根目录或用户 tmp。
    settingsManager,
    noExtensions: true, // 不加载磁盘上的 .pi 扩展；本进程显式注册工具。
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // noExtensions 只禁用磁盘发现；这些受信任的内联扩展仍由代码显式加载。
    extensionFactories: [toolPolicy.extension, createSystemPromptTrimExtension()],
    appendSystemPromptOverride: (base) => [
      ...base,
      buildChatContext({ tempDir, index, pythonReady }),
    ],
  });
  await resourceLoader.reload();
  const localTools = await buildLocalTools({
    workspaceDir: cwd,
    tempDir,
    phone,
    groupId,
    venvDir,
    materialsIndexPath: indexPath,
  });
  const outboundNotes = createOutboundNotes();

  const { session } = await createAgentSession({
    cwd, // Pi session 与工具的默认目录都是群共享 <group>/workspace/。
    model,
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    // 同名 custom tool 覆盖内置定义：仍复用 Pi 官方工具工厂，只增加路径边界和调用者临时环境。
    tools: ["read", "bash", "edit", "write", "send_image", "send_file"],
    customTools: [
      ...localTools,
      ...buildSendTools({
        getCallbackUrl: () => sessionCallbackUrls.get(key) ?? callbackUrl,
        groupId,
        workspaceDir: cwd,
        tempDir,
        relay: getRelayConfig(),
        notes: outboundNotes,
      }),
    ],
    thinkingLevel,
  });
  terminalToolBlockStates.set(session, toolPolicy.state);
  sessionOutboundNotes.set(session, outboundNotes);
  sessions.set(key, session);
  sessionLastUsed.set(key, Date.now());
  log.info(
    `新建会话 - 用户: ${phone}, 群: ${groupId}, Pi session: ${session.sessionManager.getSessionId()}`
  );
  return session;
}

async function getOrCreateSession(
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<AgentSession | null> {
  const key = sessionKey(phone, groupId);
  if (!acceptingRequests) return null;
  const clearing = sessionClears.get(key);
  if (clearing) await clearing;
  if (!acceptingRequests) return null;
  const disposing = sessionDisposals.get(key);
  if (disposing) await disposing;
  if (!acceptingRequests) return null;
  sessionCallbackUrls.set(key, callbackUrl);
  const existing = sessions.get(key);
  if (existing) {
    sessionLastUsed.set(key, Date.now());
    return existing;
  }
  const pending = sessionCreations.get(key);
  if (pending) {
    const session = await pending;
    return acceptingRequests ? session : null;
  }

  const creation = createSession(phone, groupId, callbackUrl);
  sessionCreations.set(key, creation);
  try {
    const session = await creation;
    sessionLastUsed.set(key, Date.now());
    return acceptingRequests ? session : null;
  } catch (error) {
    if (!sessions.has(key)) sessionCallbackUrls.delete(key);
    throw error;
  } finally {
    if (sessionCreations.get(key) === creation) sessionCreations.delete(key);
  }
}

/**
 * Clear is one per-user transaction: stop the active turn, wait for runPrompt's
 * outer work, dispose the SDK session, then remove its JSONL before allowing a
 * new session for the same (group, phone).
 */
async function clearUserSession(
  session: AgentSession,
  phone: string,
  groupId: string
): Promise<ClearResult> {
  const key = sessionKey(phone, groupId);
  const existing = sessionClears.get(key);
  if (existing) return existing;

  const clear = (async (): Promise<ClearResult> => {
    if (busySessions.has(session)) {
      abortingSessions.add(session);
      runOutboundControllers.get(session)?.abort();
      try {
        await session.abort();
        await activeRuns.get(session);
      } catch (error) {
        log.error(`clear abort 失败 - 用户: ${phone}, 错误: ${String(error)}`);
        abortingSessions.delete(session);
        return {
          ok: false,
          message: "⚠️ 当前任务未能停止，会话历史没有删除；请稍后重试 /clear",
        };
      }
    }

    if (sessions.get(key) === session) sessions.delete(key);
    sessionLastUsed.delete(key);
    sessionCallbackUrls.delete(key);
    await disposeSession(key, session);
    lastTool.delete(session);
    busySessions.delete(session);

    const historyPath = resolve(
      sessionFilePath(GROUP_DATA_ROOT, groupId, phone)
    );
    try {
      await unlink(historyPath);
      log.info(
        `已删除会话文件 - 用户: ${phone}, 群: ${groupId}, 文件: ${historyPath}`
      );
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true };
      }
      log.error(
        `删除会话文件失败 - 用户: ${phone}, 群: ${groupId}, 错误: ${String(error)}`
      );
      return {
        ok: false,
        message: "⚠️ 会话已关闭，但历史文件删除失败；请检查目录权限后重试 /clear",
      };
    }
  })();

  sessionClears.set(key, clear);
  try {
    return await clear;
  } finally {
    if (sessionClears.get(key) === clear) sessionClears.delete(key);
  }
}

// ===== 工具状态摘要 =====
// 只供 /status 查询，不逐次发到群里，避免 Flash 模型密集调用工具时撞 IM 发送限额。
const PREFERRED_ARG_KEYS = [
  "command", "cmd", "path", "file_path", "filePath", "source", "filename", "url", "pattern", "query",
];
const NOISY_ARG_KEYS = new Set([
  "content", "newContent", "oldContent", "new_string", "old_string", "patch", "diff", "text",
]);

function truncateOneLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/** 把一次工具调用摘要成一行：优先取标识字段（bash→command、read/write/edit→path、send_*→source）。 */
function summarizeToolCall(toolName: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  for (const k of PREFERRED_ARG_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) {
      return `${toolName}: ${truncateOneLine(v, 100)}`;
    }
  }
  const small: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (NOISY_ARG_KEYS.has(k)) continue;
    small[k] = v;
  }
  const json = Object.keys(small).length ? JSON.stringify(small) : "";
  return json ? `${toolName} · ${truncateOneLine(json, 120)}` : toolName;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "AbortError") return true;
    if (e.message.toLowerCase().includes("abort")) return true;
  }
  return false;
}

/**
 * 这一轮模型侧的真实失败原因。
 *
 * provider 的报错不会从 prompt() 抛出来：Pi 把它写成一条 stopReason 为 "error"、正文为空
 * 的 assistant 消息，并记在 state.errorMessage 上（每轮开始时清空，所以读到的必属本轮）。
 * 不读这里就只剩「没有回复」这种没法排查的结论——额度耗尽、key 失效、限流全长这样。
 */
function readTurnFailure(session: AgentSession): string | undefined {
  try {
    const state = session.state;
    if (state.errorMessage) return state.errorMessage;
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== "assistant") return undefined;
    if (last.stopReason !== "error" && last.stopReason !== "aborted") return undefined;
    return last.errorMessage || `模型请求 ${last.stopReason}`;
  } catch (e) {
    log.error(`读取模型失败原因出错: ${String(e)}`);
    return undefined;
  }
}

/** 订阅 Pi 会话事件：记录最近工具供 /status 查询，并把自动重试写进日志。
 *  工具消息不发群里，重试也不发——它们只在排查时有用。 */
function recordSessionProgress(
  event: AgentSessionEvent,
  session: AgentSession,
  phone: string
): void {
  if (event?.type === "tool_execution_start" && event.toolName) {
    const summary = summarizeToolCall(event.toolName, event.args);
    lastTool.set(session, summary);
    return;
  }
  // 重试是「慢」和「最终失败」的原因；只有最后一次的报错会留在 state 上。
  if (event?.type === "auto_retry_start") {
    log.warn(
      `模型请求失败，自动重试 ${event.attempt}/${event.maxAttempts}（${event.delayMs}ms 后）- 用户: ${phone}, 原因: ${event.errorMessage}`
    );
    return;
  }
  if (event?.type === "auto_retry_end" && !event.success) {
    log.error(
      `模型请求重试 ${event.attempt} 次后仍失败 - 用户: ${phone}, 原因: ${event.finalError ?? "未知"}`
    );
  }
}

/**
 * Drop steering/follow-up messages that were queued for a turn which no longer
 * exists. Pi's abort() only cancels the active run; the agent loop reads its
 * steering queue at the start of the *next* run, so anything left over would be
 * injected into an unrelated later task. Returns how many were discarded.
 */
function discardQueuedInterventions(session: AgentSession): number {
  try {
    const { steering, followUp } = session.clearQueue();
    return steering.length + followUp.length;
  } catch (e) {
    log.error(`清空干预队列失败: ${String(e)}`);
    return 0;
  }
}

/** /指令 路由：立即处理，不进 prompt/steer。 */
async function handleCommand(
  session: AgentSession,
  content: string,
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<void> {
  const cmd = canonicalCommand(content);
  const reply = async (msg: string): Promise<boolean> => {
    try {
      const sent = await sendText(msg, groupId, phone, callbackUrl);
      if (!sent) log.error(`指令回执未送达 - 用户: ${phone}`);
      return sent;
    } catch (e) {
      log.error(`指令回执失败 - 用户: ${phone}, 错误: ${String(e)}`);
      return false;
    }
  };

  switch (cmd) {
    case "/help":
      await reply(HELP_TEXT);
      return;

    case "/stop": {
      if (!busySessions.has(session)) {
        await reply("ℹ️ 当前没有正在执行的任务");
        return;
      }
      abortingSessions.add(session);
      runOutboundControllers.get(session)?.abort();
      try {
        await session.abort();
        await activeRuns.get(session);
      } catch (e) {
        log.error(`abort 失败 - 用户: ${phone}, 错误: ${String(e)}`);
        abortingSessions.delete(session);
        await reply("⚠️ 停止任务失败，请稍后重试");
        return;
      }
      // abort() 只取消在跑的这一轮，排队中的 steer 会留到下次 prompt 开头注入。
      // 这个 session 会继续服务下一个任务，所以丢弃属于已停任务的干预。
      const dropped = discardQueuedInterventions(session);
      await reply(
        dropped > 0
          ? `⏹ 已强制停止当前任务，并丢弃 ${dropped} 条未消化的干预`
          : "⏹ 已强制停止当前任务"
      );
      return;
    }

    case "/status": {
      const busy = busySessions.has(session);
      const pending = typeof session.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
      const last = lastTool.get(session) ?? "无";
      const rate = getOutboundRateStatus(callbackUrl);
      const workspace = getWorkspaceCoordinationStatus(
        resolve(groupWorkspaceDir(GROUP_DATA_ROOT, groupId))
      );
      const workspaceMode = workspace.opaqueActive
        ? "bash 独占操作中"
        : workspace.fileMutations > 0
          ? `${workspace.fileMutations} 个文件写操作进行中`
          : "空闲";
      const rateMode = {
        normal: "正常",
        reduced: "状态消息已降频",
        full: "关键消息排队中",
        cooldown: "平台限流冷却中",
      }[rate.mode];
      await reply(
        `状态：${busy ? "忙碌中" : "空闲"}\nPi 会话：${session.sessionManager.getSessionId()}\n待消化的干预：${pending} 条\n群工作区协调：${workspaceMode}${workspace.waiting ? `，另有 ${workspace.waiting} 个操作等待` : ""}\n最近工具：🔧 ${last}\n机器人发送窗口：${rate.used}/${rate.limit}（${rateMode}${rate.pending ? `，排队 ${rate.pending}` : ""}）`
      );
      return;
    }

    case "/clear": {
      const result = await clearUserSession(session, phone, groupId);
      await reply(
        result.ok
          ? "🗑 已清空你在本群的会话历史；下一条消息将开启新会话"
          : result.message
      );
      return;
    }

    default:
      await reply(unknownCommandText(content));
  }
}

async function runPrompt(
  session: AgentSession,
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  let finishRun!: () => void;
  const runFinished = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const outboundController = new AbortController();
  activeRuns.set(session, runFinished);
  runOutboundControllers.set(session, outboundController);
  busySessions.add(session);
  const unsub: (() => void) | undefined =
    typeof session.subscribe === "function"
      ? session.subscribe((event: AgentSessionEvent) =>
          recordSessionProgress(event, session, phone)
        )
      : undefined;

  const start = Date.now();
  const key = sessionKey(phone, groupId);
  const getCallbackUrl = () => sessionCallbackUrls.get(key) ?? callbackUrl;
  try {
    // Slash commands return from handleUserMessage before runPrompt, so only
    // normalized ordinary prompt text reaches this acknowledgement.
    await sendText("🤔 正在思考...", groupId, phone, getCallbackUrl(), {
      traffic: "status",
      signal: outboundController.signal,
    });
    // /stop 或 /clear 可能发生在状态消息发送期间。
    if (abortingSessions.has(session)) {
      abortingSessions.delete(session);
      return;
    }
    await session.prompt(content);
    // 被 /stop /clear 中断 → 不发回复（指令已自己回执）
    if (abortingSessions.has(session)) {
      abortingSessions.delete(session);
      log.info(`任务被指令中断，跳过回复 - 用户: ${phone}`);
      return;
    }
    const replyText =
      consumeTerminalToolBlockReply(terminalToolBlockStates.get(session)) ??
      session.getLastAssistantText();
    // 工具留下的必送文本（大文件外链）随这一条回复一起走，而不是各发各的：平台按条
    // 限流，「工具发链接 + 模型发说明」会让一次发送吃掉两条配额。
    //
    // 这里只 peek 不清空：送达之前先清掉的话，一旦发送失败，链接就既没进群也不在
    // 兜底队列里了，而文件已经在外链后端上躺着。
    const notes = sessionOutboundNotes.get(session);
    const pending = notes?.peek() ?? [];
    const appendix = pending.length > 0 ? pending.join("\n\n") : undefined;
    // 模型什么都没说但文件确实发出去了时，链接本身就是完整的回复。
    const failure = readTurnFailure(session);
    if (!replyText && !appendix) {
      throw new Error(failure ? `模型未返回回复：${failure}` : "Pi 未返回回复");
    }
    // 有内容就照发（流到一半才出错的轮次仍有话可说），但失败本身不能只烂在内存里。
    if (failure) {
      log.warn(`模型本轮报错但仍有内容可发 - 用户: ${phone}, 错误: ${failure}`);
    }
    const body = replyText || "文件已发送。";
    log.info(
      `Pi 回复完成 - 用户: ${phone}, 耗时: ${((Date.now() - start) / 1000).toFixed(2)}秒, 长度: ${body.length}`
    );
    const sent = await sendReplyWithMention(
      body,
      groupId,
      phone,
      getCallbackUrl(),
      outboundController.signal,
      appendix
    );
    if (!sent) throw new Error("Pi 回复生成成功，但群聊消息发送失败");
    notes?.clear();
  } catch (e) {
    // 中断（AbortError 或 abortingSessions）→ 静默；其余异常上抛由 processRequest 兜底回错误提示
    if (abortingSessions.has(session) || isAbortError(e)) {
      abortingSessions.delete(session);
      log.info(`任务被中断（abort），跳过回复 - 用户: ${phone}`);
      return;
    }
    throw e;
  } finally {
    // 兜底：正常路径上 drain 已经清空了，这里拿到东西只可能是回复没发出去（模型报错、
    // /stop、发送失败）。文件此时已经躺在外链后端上了，链接跟着失败一起消失的话，谁都
    // 拿不到它，而且它还会一直占着网盘直到过期。所以单独补发一条，且不带本轮的
    // AbortSignal——那个信号多半正是导致走到这里的原因。
    const orphaned = sessionOutboundNotes.get(session)?.drain() ?? [];
    if (orphaned.length > 0) {
      log.warn(`本轮回复未送达，单独补发外链消息 - 用户: ${phone}, 群: ${groupId}`);
      await sendText(orphaned.join("\n\n"), groupId, phone, getCallbackUrl()).catch((e) =>
        log.error(`外链消息补发失败 - 用户: ${phone}, 错误: ${String(e)}`)
      );
    }
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
    busySessions.delete(session);
    if (sessions.get(key) === session) sessionLastUsed.set(key, Date.now());
    if (activeRuns.get(session) === runFinished) activeRuns.delete(session);
    if (runOutboundControllers.get(session) === outboundController) {
      runOutboundControllers.delete(session);
    }
    finishRun();
  }
}

/** /指令立即处理；当前用户忙时 steer；不同用户并发，文件写入由工具层协调。 */
export async function handleUserMessage(
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  if (!acceptingRequests) return;
  let session = await getOrCreateSession(phone, groupId, callbackUrl);
  if (!session || !acceptingRequests) return;
  const key = sessionKey(phone, groupId);
  // A concurrent /clear can replace the session while getOrCreateSession is
  // yielding. Refresh once before routing commands, steer, or a new prompt.
  if (sessions.get(key) !== session) {
    session = await getOrCreateSession(phone, groupId, callbackUrl);
    if (!session || !acceptingRequests) return;
  }
  const trimmed = content.trim();

  if (isSlashCommandMessage(trimmed)) {
    await handleCommand(session, trimmed, phone, groupId, callbackUrl);
    return;
  }

  // The platform includes the leading @bot mention in textMsg.content. It is
  // transport syntax rather than part of the user's prompt, so remove it once
  // before prompt/steer while preserving later mentions in the actual message.
  const promptContent = stripLeadingMention(trimmed);

  if (busySessions.has(session) && abortingSessions.has(session)) {
    await activeRuns.get(session);
    if (!acceptingRequests) return;
  } else if (busySessions.has(session)) {
    try {
      await session.steer(promptContent);
      await sendText("↩️ 已插入干预，agent 将在下一步纳入", groupId, phone, callbackUrl);
    } catch (e) {
      log.error(`steer 失败 - 用户: ${phone}, 错误: ${String(e)}`);
      await sendText("⚠️ 干预插入失败，请稍后重试", groupId, phone, callbackUrl).catch(() => {});
    }
    return;
  }

  // There is intentionally no await between the busy check above and
  // runPrompt marking this session busy, preventing concurrent prompts on one
  // AgentSession while still allowing different users to run together.
  await runPrompt(session, phone, groupId, promptContent, callbackUrl);
}

/** 应用关闭时释放所有 session。 */
export async function disposeAllSessions(): Promise<void> {
  acceptingRequests = false;
  abortOutboundRequests();
  await Promise.allSettled(sessionCreations.values());
  const runningSessions = [...activeRuns.keys()];
  for (const session of runningSessions) {
    abortingSessions.add(session);
    runOutboundControllers.get(session)?.abort();
  }
  await Promise.allSettled(runningSessions.map((session) => session.abort()));
  await Promise.allSettled(activeRuns.values());
  await Promise.allSettled(sessionClears.values());
  for (const [key, session] of sessions) {
    await disposeSession(key, session);
  }
  sessions.clear();
  sessionLastUsed.clear();
  sessionCallbackUrls.clear();
  sessionClears.clear();
  activeRuns.clear();
  await Promise.allSettled(sessionDisposals.values());
}

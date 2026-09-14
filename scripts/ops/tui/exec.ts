// 非交互子进程：capture 收集结果，stream 逐行显示过程；交互终端交接由 App 处理。
// 参数通过 argv 传递，维护事务在界面退出前统一等待完成。

import { PROJECT_DIR, type Platform } from "./platform.ts";
import { QueryPool } from "./exec-client.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 超时被杀掉时为 true；此时 code 不可信。 */
  timedOut: boolean;
}

export interface CaptureOptions {
  /** 毫秒；到点终止子进程。默认 20 秒。 */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** 喂给子进程 stdin 的内容；不给则关闭 stdin。 */
  input?: string;
  signal?: AbortSignal;
}

let queries = new QueryPool();
export function startQueries(): void { if (queries.closed) queries = new QueryPool(); }

/** 取消只读查询，同时等待维护事务完成恢复；各自的进程生命周期互不影响。 */
export async function shutdownTui(): Promise<void> {
  const results = await Promise.allSettled([queries.stop(), drainMaintenance()]);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

interface StreamOptions {
  env?: Record<string, string>;
  /** A maintenance transaction must finish its restoration before the UI exits. */
  cancelMode?: "terminate" | "finish";
}

/**
 * 跑一条命令并收集输出。
 *
 * stdin 默认关闭而不是继承：继承的话，一条意外要求确认的命令会安静地吃掉用户在 TUI 里
 * 的按键，界面看上去像卡死了。关掉 stdin 让它立刻失败，我们至少能把错误显示出来。
 */
export function capture(
  command: string,
  args: string[],
  options: CaptureOptions = {}
): Promise<RunResult> {
  return queries.capture(command, args, options);
}

/** 用户主动打开的浏览器必须能在 TUI 退出后继续运行，不纳入查询进程树。 */
async function launchOpener(command: string, args: string[], options: CaptureOptions = {}): Promise<RunResult> {
  const { timeout = 20_000, env, input } = options;
  const child = Bun.spawn([command, ...args], {
    cwd: PROJECT_DIR,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    windowsHide: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandle {
  /** 结束后 resolve 为退出码。 */
  done: Promise<number>;
  /** 请求取消；受保护的维护操作只提示等待，不终止子进程。 */
  cancel(): void;
}

const maintenance = new Set<Promise<number>>();
export function trackMaintenance(done: Promise<number>): Promise<number> {
  maintenance.add(done);
  void done.finally(() => maintenance.delete(done)).catch(() => {});
  return done;
}
async function drainMaintenance(): Promise<void> {
  await Promise.allSettled([...maintenance]);
}

/**
 * 跑一条命令并按行回调。
 *
 * stdout 和 stderr 分别按行缓冲，按读取顺序合并回调；不保证两个管道间的发出顺序。
 */
export function stream(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  options: StreamOptions = {}
): StreamHandle {
  const child = Bun.spawn([command, ...args], {
    cwd: PROJECT_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });

  const pump = async (source: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of source) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (buffer) onLine(buffer);
  };

  const done = (async (): Promise<number> => {
    const output = await Promise.allSettled([pump(child.stdout), pump(child.stderr)]);
    const code = await child.exited;
    const failed = output.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return code;
  })();

  if (options.cancelMode === "finish") {
    trackMaintenance(done);
  }
  let requested = false;
  return { done, cancel: () => {
    if (options.cancelMode !== "finish") { child.kill(); return; }
    if (!requested) onLine("维护已进入受保护流程，正在完成操作并恢复服务；请等待退出结果。");
    requested = true;
  } };
}

/** 解析命令的 JSON 输出。失败时把原始输出带进错误，方便看清它到底打了什么。 */
export function parseJson<T>(result: RunResult, what: string): T {
  const text = result.stdout.trim();
  if (!text) {
    const detail = result.stderr.trim() || `退出码 ${result.code}`;
    throw new Error(`${what} 没有输出：${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} 的输出不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 文件路径作为参数或环境变量传递，不拼进 shell 代码。 */
export async function openLocalFile(path: string, platform: Platform): Promise<void> {
  const result = platform === "windows"
    ? await launchOpener("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:MIXIN_OPS_OPEN_FILE"], { env: { MIXIN_OPS_OPEN_FILE: path } })
    : Bun.which("xdg-open") ? await launchOpener("xdg-open", [path]) : null;
  if (!result || result.code !== 0 || result.timedOut) throw new Error("当前主机无法打开浏览器；报表路径已保留，可复制到本地查看");
}

// 子进程。所有写操作都从这里出去，TUI 自己不碰 docker、git 和计划任务。
//
// 分两种用法：
//   capture —— 要一个结果（体检 JSON、git 状态），等它跑完拿输出。
//   stream  —— 要过程（升级、重启、清理），边跑边把每一行喂回界面。
//
// 一律用参数数组，不拼 shell 字符串：群号和关键字来自用户输入，拼进 shell 就是注入。

import { PROJECT_DIR, type Platform } from "./platform.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 超时被杀掉时为 true；此时 code 不可信。 */
  timedOut: boolean;
}

export interface RunOptions {
  /** 毫秒；到点发送 SIGTERM。默认 20 秒，够用又不会让界面挂死。 */
  timeout?: number;
  env?: Record<string, string>;
  /** 喂给子进程 stdin 的内容；不给则关闭 stdin。 */
  input?: string;
}

/**
 * 跑一条命令并收集输出。
 *
 * stdin 默认关闭而不是继承：继承的话，一条意外要求确认的命令会安静地吃掉用户在 TUI 里
 * 的按键，界面看上去像卡死了。关掉 stdin 让它立刻失败，我们至少能把错误显示出来。
 */
export async function capture(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
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
  /** 提前中止（用户按了 Esc）。 */
  cancel(): void;
}

/**
 * 跑一条命令并按行回调。
 *
 * stdout 和 stderr 合到一起按时间顺序回调：运维读的是一条时间线，把警告单独拎出来放在
 * 最后反而看不出它发生在哪一步。行级缓冲自己做，因为管道的分块边界和换行没有关系
 * ——按 chunk 直接输出会把一行劈成两半。
 */
export function stream(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  options: RunOptions = {}
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
    await Promise.all([pump(child.stdout), pump(child.stderr)]);
    return child.exited;
  })();

  return { done, cancel: () => child.kill() };
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
    ? await capture("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:MIXIN_OPS_OPEN_FILE"], { env: { MIXIN_OPS_OPEN_FILE: path } })
    : Bun.which("xdg-open") ? await capture("xdg-open", [path]) : null;
  if (!result || result.code !== 0 || result.timedOut) throw new Error("当前主机无法打开浏览器；报表路径已保留，可复制到本地查看");
}

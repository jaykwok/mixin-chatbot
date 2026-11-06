// 宿主机只读查询（体检、Git、配置校验等）的执行接口。共享读取模块只依赖这里；进程如何启动、取消和回收由
// 控制台在启动时注册（console/main.ts 注册 shared/exec-client.ts 的查询进程池），共享模块不自带一套。

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

type Capture = (command: string, args: string[], options: CaptureOptions) => Promise<RunResult>;

let runner: Capture | undefined;

/** 宿主进程启动时注册一次；之后的注册替换前一个。 */
export function setQueryRunner(run: Capture): void {
  runner = run;
}

/** 跑一条只读查询并收集输出；没有注册执行器时直接报错，不退回未受监督的子进程。 */
export function capture(command: string, args: string[], options: CaptureOptions = {}): Promise<RunResult> {
  if (!runner) return Promise.reject(new Error("宿主机查询执行器尚未注册"));
  return runner(command, args, options);
}


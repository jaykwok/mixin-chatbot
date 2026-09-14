import type { FromHost } from "./exec-protocol.ts";

/** Observe all three channels immediately; one failed stream must still retire its host. */
export async function observeQueryProcess(
  child: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> },
  receive: (message: FromHost) => void,
  retire: () => void,
): Promise<string> {
  let error = "查询进程已退出";
  const failed = (cause: unknown) => {
    error = String(cause);
    try { retire(); } catch (cleanup) { error += `；回收失败：${String(cleanup)}`; }
  };
  const exited = child.exited.catch(failed);
  const stderr = new Response(child.stderr).text().catch(cause => { failed(cause); return ""; });
  try {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        receive(JSON.parse(line) as FromHost);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error("查询进程返回了不完整的消息");
  } catch (cause) { failed(cause); }
  await exited;
  return (await stderr).trim() || error;
}

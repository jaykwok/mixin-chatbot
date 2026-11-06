// Builds the console page in memory at startup. Linux Docker hosts have no node_modules, so the only bare imports the
// page may use are the vendored Preact files; everything else must stay inside console/ui/src.
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SOURCE_DIR } from "../../ops/core/platform.ts";

export const UI_DIR = join(SOURCE_DIR, "console", "ui");

const VENDORED: Record<string, string> = {
  "preact": "preact.mjs",
  "preact/hooks": "hooks.mjs",
  "preact/jsx-runtime": "jsx-runtime.mjs",
  "preact/jsx-dev-runtime": "jsx-runtime.mjs",
};

export interface Asset { path: string; type: string; body: Uint8Array }

/** Every byte the browser can load, built once and served from memory: later code changes on disk do not leak in. */
export interface Bundle { index: Asset; assets: Map<string, Asset> }

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const hash = (body: Uint8Array) => new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 12);

export async function buildBundle(root = UI_DIR): Promise<Bundle> {
  const source = join(root, "src"), vendor = join(root, "vendor", "preact");
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [join(source, "main.tsx")],
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "none",
      splitting: false,
      jsx: { runtime: "automatic", importSource: "preact", development: false },
      plugins: [{
        name: "console-boundary",
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.kind === "entry-point-build" || args.kind === "entry-point-run") return undefined;
            const vendored = VENDORED[args.path];
            if (vendored) return { path: join(vendor, vendored) };
            if (args.path.startsWith("./") || args.path.startsWith("../")) {
              const target = resolve(dirname(args.importer), args.path);
              if (inside(source, target)) return undefined;
              throw new Error(`页面代码只能引用 console/ui/src 内的文件：${args.path}（来自 ${relative(root, args.importer)}）`);
            }
            throw new Error(`页面代码不能引用 ${args.path}（来自 ${relative(root, args.importer)}）；只允许内置的 Preact`);
          });
        },
      }],
    });
  } catch (error) {
    throw new Error(`控制台页面构建失败：${describeBuildError(error)}`);
  }
  if (!result.success) throw new Error(`控制台页面构建失败：${result.logs.map(String).join("\n")}`);

  const assets = new Map<string, Asset>();
  let script: Asset | undefined, style: Asset | undefined;
  for (const output of result.outputs) {
    const body = new Uint8Array(await output.arrayBuffer());
    if (output.path.endsWith(".js")) {
      script = { path: `/assets/app.${hash(body)}.js`, type: "text/javascript; charset=utf-8", body };
      assets.set(script.path, script);
    } else if (output.path.endsWith(".css")) {
      style = { path: `/assets/app.${hash(body)}.css`, type: "text/css; charset=utf-8", body };
      assets.set(style.path, style);
    } else {
      throw new Error(`控制台页面构建产生了未预期的文件：${output.path}`);
    }
  }
  if (!script || !style) throw new Error("控制台页面构建缺少脚本或样式");

  const iconBody = new Uint8Array(await Bun.file(join(root, "icon.svg")).arrayBuffer());
  const icon: Asset = { path: `/assets/icon.${hash(iconBody)}.svg`, type: "image/svg+xml", body: iconBody };
  assets.set(icon.path, icon);

  // Only static markup: no inline script or style, so the CSP can stay at 'self'.
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>量子密信应用机器人控制台</title>
<link rel="icon" href="${icon.path}" type="image/svg+xml">
<link rel="stylesheet" href="${style.path}">
<script type="module" src="${script.path}"></script>
</head>
<body>
<div id="app"></div>
<noscript>控制台需要启用 JavaScript。</noscript>
</body>
</html>
`;
  return { index: { path: "/", type: "text/html; charset=utf-8", body: new TextEncoder().encode(html) }, assets };
}

function describeBuildError(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(describeBuildError).join("\n");
  return error instanceof Error ? error.message : String(error);
}

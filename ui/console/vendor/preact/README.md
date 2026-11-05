# 内置 Preact 运行时

控制台在宿主机启动时用 `Bun.build` 在内存中打包页面。Linux Docker 部署的宿主机没有 `node_modules`，所以页面运行时随仓库提供，版本与 `package.json` 锁定的 `preact` 一致（当前 11.0.2）。

| 本目录文件 | 来源（`node_modules/preact/`） |
| --- | --- |
| `preact.mjs` | `dist/preact.mjs` |
| `hooks.mjs` | `hooks/dist/hooks.mjs` |
| `jsx-runtime.mjs` | `jsx-runtime/dist/jsxRuntime.mjs` |
| `LICENSE` | `LICENSE`（MIT） |

升级 `preact` 后重新复制上表文件；`tests/console/vendor.test.ts` 逐字节比对，版本不一致时测试失败。不要手工修改这些文件。

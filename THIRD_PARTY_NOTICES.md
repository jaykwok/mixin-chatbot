# Third-party notices

The project integrates the official Pi SDK and its tool factories. `src/agent/tool-path.ts` adapts the path resolution semantics from [Pi 0.85.1, packages/coding-agent/src/utils/paths.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/utils/paths.ts), because that helper is not part of Pi's public SDK exports. Its parity tests must be checked when upgrading Pi.

The following [Pi license](https://github.com/earendil-works/pi/blob/v0.85.1/LICENSE) applies to that adapted code:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Other direct packages retain their upstream licenses in their distributions:

| Component | Use | Upstream |
|---|---|---|
| Pi AI / coding-agent | Models, sessions, compaction, tools and cancellation | [earendil-works/pi](https://github.com/earendil-works/pi) |
| Hono | HTTP routing | [honojs/hono](https://github.com/honojs/hono) |
| Marked | Markdown tokenization | [markedjs/marked](https://github.com/markedjs/marked) |
| proper-lockfile | Service and maintenance exclusion | [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) |
| fs-extra | Recoverable moves across filesystems | [jprichardson/node-fs-extra](https://github.com/jprichardson/node-fs-extra) |
| Clack | Configuration prompts | [bombshell-dev/clack](https://github.com/bombshell-dev/clack) |
| Knip | Development dependency and export analysis | [webpro-nl/knip](https://github.com/webpro-nl/knip) |

`patches/knip@6.29.0.patch` preserves production entry metadata for Bun scripts. Bun applies this development-only patch during installation. Remove it when upstream handles those entries correctly and both ordinary and production checks pass. It is not a replacement implementation of Knip.

import { holdDirectory } from "../../src/core/held-directory.ts";

if (!process.argv[2]) throw new Error("expected synthetic directory path");
const held = await holdDirectory(process.argv[2], [], false);
try {
  console.log("READY");
  await new Response(Bun.stdin.stream()).text();
} finally { await held.release(); }

import { ensureMaterialsIndex } from "../../src/agent/materials-index.ts";
import { application } from "../../src/core/lifecycle.ts";
const result = await ensureMaterialsIndex(JSON.parse(process.argv[2]!));
await application.drain();
console.log("INDEX_RESULT=" + JSON.stringify(result));

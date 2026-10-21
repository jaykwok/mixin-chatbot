import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { CloseoutStore, freezeFile, type FileSend } from "../../src/agent/deliverables.ts";

const [root, boundary] = process.argv.slice(2);
if (!root || !["planned", "sending", "sent"].includes(boundary!)) throw new Error("expected fixture and boundary");
const db = new Database(join(root, "state.sqlite")); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
const store = new CloseoutStore(new DeliveryStore(db)), temp = join(root, "tmp"); await mkdir(temp, { recursive: true });
const source = join(temp, "report.txt"); await writeFile(source, "retained snapshot");
const frozen = await freezeFile(source, temp, "request", 1024);
const item = store.register({ ...frozen, session: '["group-a","1001"]', requestId: "request", slot: "report", complete: true,
  status: "draft", checked: [], unchecked: ["layout"], issues: [] });
store.createPlan(item.session, "request", "explanation first", [item], 120000);
const file = store.files(item.session)[0]!;
if (boundary !== "planned") store.saveFile({ ...file, attempts: 1, state: boundary as FileSend["state"] });
process.stdout.write("READY\n");
setInterval(() => {}, 1000); // Keep the process alive until the parent forcibly kills it.
await new Promise(() => {});

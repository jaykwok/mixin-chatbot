// The recovery record of the offline shrink (shrink.ts): data/state/shrink.json for the current or last run, earlier runs
// in data/state/shrink/<run>.json. Read by the maintenance state (maintenance-state.ts), which refuses to start the
// service, a release or other maintenance while a replacement is unfinished.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publishJson } from "../../../scripts/lib/atomic-file.ts";
import type { Replacement } from "./replace.ts";
import { readStateFile } from "../../core/state-file.ts";

export type Shrunk = { space: string; before: number; after: number; ms: number; kept: string };
export type ShrinkRecord = { version: 1; run: string; startedAt: string; endedAt?: string; current?: Replacement; done: Shrunk[] };

export const shrinkRecordPath = (data: string) => join(data, "state", "shrink.json");
export const shrinkHistory = (data: string) => join(data, "state", "shrink");

function parse(path: string, text = readFileSync(path, "utf8")): ShrinkRecord {
  const record = JSON.parse(text) as ShrinkRecord;
  if (record?.version !== 1 || typeof record.run !== "string" || !Array.isArray(record.done)) throw new Error(`会话库收缩记录无法识别：${path}`);
  return record;
}

export function readShrinkRecord(data: string): ShrinkRecord | undefined {
  const path = shrinkRecordPath(data), text = readStateFile(path);
  return text === undefined ? undefined : parse(path, text);
}
export const writeShrinkRecord = (data: string, record: ShrinkRecord): Promise<void> => publishJson(shrinkRecordPath(data), record);

/** The records of earlier runs, oldest first. */
export function archivedShrinkRecords(data: string): ShrinkRecord[] {
  const directory = shrinkHistory(data);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => parse(join(directory, name)));
}

// Secrets stay in the already protected .console tree. Browser DTOs are explicit projections only.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configurationForm, configurationSnapshot, assertConfigurationBase,
  editConfiguration, type ConfigurationKind, type ConfigurationSnapshot } from "../config/configuration-form.ts";
import { writeAtomic } from "./console-state.ts";
import { configurationDigest, parseConfigurationDraft, type ConfigurationDraft } from "../config/configuration-draft.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import type { TaskObservers, TaskStore } from "./tasks.ts";

const ID = /^config-[a-f0-9]{32}$/;
const TTL = 30 * 60_000;
export class ConfigurationDrafts {
  readonly root: string;
  constructor(readonly project: string, readonly now = Date.now) {
    this.root = join(project, ".console/config-drafts"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("配置草稿目录不私有或不是普通目录");
  }
  path(id: string): string { if (!ID.test(id)) throw new Error("配置草稿编号无效"); return join(this.root, id + ".json"); }
  private write(draft: ConfigurationDraft): void {
    const text = JSON.stringify(draft) + "\n";
    if (Buffer.byteLength(text) > 40 * 1024 * 1024) throw new Error("配置草稿过大，请检查模型目录缓存");
    writeAtomic(this.path(draft.id), text);
  }
  read(id: string): ConfigurationDraft {
    const path = this.path(id), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40 * 1024 * 1024) throw new Error("配置草稿损坏，已保留现场");
    return parseConfigurationDraft(readFileSync(path, "utf8"), id);
  }
  task(id: string): string | undefined {
    try {
      const path = this.path(id) + ".task", stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error("配置草稿接单记录无效");
      const value = readFileSync(path, "utf8"); if (!/^task-[a-f0-9]{32}$/.test(value)) throw new Error("配置草稿接单记录无效"); return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  private owned(id: string, session: string, revision?: number): ConfigurationDraft {
    const value = this.read(id);
    if (value.session !== session || value.expiresAt <= this.now()) throw new Error("配置草稿已过期，请重新打开");
    if (this.task(id)) throw new Error("草稿已交接任务，请在任务页查看结果");
    if (revision !== undefined && revision !== value.revision) throw new Error("草稿已变化，请重新读取");
    return value;
  }
  view(id: string, session: string) {
    const draft = this.owned(id, session);
    return { id, revision: draft.revision, expiresAt: draft.expiresAt, form: configurationForm(draft.next),
      validated: draft.validated?.digest === configurationDigest(draft), summary: draft.validated?.summary ?? [] };
  }
  create(kind: ConfigurationKind, session: string) {
    this.prune();
    const own = readdirSync(this.root).filter(name => /^config-[a-f0-9]{32}\.json$/.test(name))
      .map(name => this.read(name.slice(0, -5))).filter(value => value.session === session && !this.task(value.id));
    if (own.length >= 4) throw new Error("未完成的配置草稿过多，请先关闭不需要的表单");
    const id = "config-" + randomUUID().replaceAll("-", ""), base = configurationSnapshot(this.project, kind), now = this.now();
    this.write({ version: 1, id, session, createdAt: now, expiresAt: now + TTL, revision: 0, base, next: structuredClone(base) });
    return this.view(id, session);
  }
  edit(id: string, session: string, revision: number, patch: unknown) {
    const draft = this.owned(id, session, revision); assertConfigurationBase(this.project, draft.base);
    draft.next = editConfiguration(draft.next, patch); draft.revision++; delete draft.validated;
    this.write(draft); return this.view(id, session);
  }
  validationInput(id: string, session: string, revision: number): { digest: string; snapshot: ConfigurationSnapshot } {
    const draft = this.owned(id, session, revision); assertConfigurationBase(this.project, draft.base);
    return { digest: configurationDigest(draft), snapshot: draft.next };
  }
  validated(id: string, session: string, revision: number, digest: string, summary: string[], catalog?: string) {
    const draft = this.owned(id, session, revision); assertConfigurationBase(this.project, draft.base);
    if (configurationDigest(draft) !== digest || !Array.isArray(summary) || summary.some(value => typeof value !== "string" || value.length > 4096)) throw new Error("校验期间草稿已变化，请重新校验");
    if (catalog !== undefined) {
      if (draft.next.kind !== "models" || typeof catalog !== "string" || Buffer.byteLength(catalog) > 8 * 1024 * 1024) throw new Error("模型目录缓存无效");
      JSON.parse(catalog); draft.next.files.catalog = catalog; draft.revision++;
    }
    draft.validated = { digest: configurationDigest(draft), summary, at: this.now() }; this.write(draft); return this.view(id, session);
  }
  prepare(id: string, session: string): { draft: string; digest: string } {
    const draft = this.owned(id, session); assertConfigurationBase(this.project, draft.base);
    const digest = configurationDigest(draft);
    if (draft.validated?.digest !== digest) throw new Error("请先校验当前配置草稿");
    return { draft: id, digest };
  }
  bind(id: string, digest: string, task: string): void {
    if (!/^task-[a-f0-9]{32}$/.test(task)) throw new Error("任务编号无效");
    if (this.task(id) === task) return;
    const draft = this.read(id); assertConfigurationBase(this.project, draft.base);
    if (draft.expiresAt <= this.now() || draft.validated?.digest !== digest || configurationDigest(draft) !== digest) throw new Error("配置草稿过期或变化");
    const fd = openSync(this.path(id) + ".task", "wx", 0o600);
    try { writeFileSync(fd, task); fsyncSync(fd); } finally { closeSync(fd); }
  }
  discard(id: string, session: string): void { this.owned(id, session); rmSync(this.path(id)); }
  finish(id: string, task: string): void {
    if (this.task(id) !== task) throw new Error("配置草稿不属于这个任务");
    if (readConfigurationState(this.project)?.id === id) return; // keep private material until explicit recovery finishes
    rmSync(this.path(id), { force: true }); rmSync(this.path(id) + ".task");
  }
  end(session: string): void {
    for (const name of readdirSync(this.root)) {
      if (!/^config-[a-f0-9]{32}\.json$/.test(name)) continue;
      const draft = this.read(name.slice(0, -5)); if (draft.session === session && !this.task(draft.id)) rmSync(this.path(draft.id));
    }
  }
  prune(): void {
    for (const name of readdirSync(this.root)) {
      if (!/^config-[a-f0-9]{32}\.json$/.test(name)) continue;
      const draft = this.read(name.slice(0, -5)); if (draft.expiresAt <= this.now() && !this.task(draft.id)) rmSync(this.path(draft.id));
    }
  }
  async reconcile(tasks: TaskStore, observers: TaskObservers): Promise<void> {
    this.prune();
    for (const name of readdirSync(this.root)) {
      if (!/^config-[a-f0-9]{32}\.json$/.test(name)) continue;
      try {
        const id = name.slice(0, -5), owner = this.task(id); if (!owner) continue;
        const request = tasks.request(owner), view = await tasks.view(owner, observers);
        if (request.operation === "configuration-apply" && request.params.draft === id
          && ["succeeded", "failed", "not-accepted"].includes(view.state)) this.finish(id, owner);
      } catch { /* Unknown/corrupt task or maintenance state is retained; a heartbeat timeout is not proof of termination. */ }
    }
  }
}

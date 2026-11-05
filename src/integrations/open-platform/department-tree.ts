// 同步范围内的部门树与部门成员：推送按部门找对象、展开名单和核对部门授权都读这里（src/push/service.ts）。
//
// 由通讯录扫描维护（identity-directory.ts）：遍历完整的一轮整体替换；应用新范围时与新名单在同一个事务里替换，没换上新名单
// 就不动。成员按手机号记，读出时与有效映射（member_directory）取交集，所以只给出能收消息的人。范围的顶层部门是同步范围
// 选定的部门（路径为平台给的完整路径，各级用“/”分隔），整个通讯录时是根部门的子部门（根部门本身不算部门）。
//
// 与映射表同等敏感：日志只写计数。
import type { Database } from "bun:sqlite";
import type { DirectoryIdentity } from "./identity-directory.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS directory_departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, path TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_department_members (department TEXT NOT NULL, phone TEXT NOT NULL, PRIMARY KEY (department, phone)) STRICT;
CREATE TABLE IF NOT EXISTS directory_tree (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), updated_at INTEGER NOT NULL) STRICT;
`;

export type Department = { id: string; name: string; parent: string | null; path: string };

/** 一轮遍历收集的部门：顶层部门（带路径），其余部门的上级与名称，每个部门的直属成员（手机号）。 */
export type TreeWalk = {
  tops: Map<string, { name: string; path: string }>;
  nodes: Map<string, { name: string; parent: string }>;
  members: Map<string, readonly string[]>;
};

export const emptyWalk = (): TreeWalk => ({ tops: new Map(), nodes: new Map(), members: new Map() });

const compact = (text: string) => text.replace(/\s+/g, "");

export class DepartmentTree {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  /** 换成这一轮的部门树。调用方在自己的事务里调用（应用新范围时与新名单一起）。 */
  replace(walk: TreeWalk, now: number): void {
    const db = this.db;
    db.exec("DELETE FROM directory_departments");
    db.exec("DELETE FROM directory_department_members");
    const insert = db.query("INSERT INTO directory_departments (id, name, parent, path) VALUES (?, ?, ?, ?)");
    const paths = new Map<string, string>();
    for (const [id, top] of walk.tops) { paths.set(id, top.path); insert.run(id, top.name, null, top.path); }
    // Parents before children: down from the tops, so a node whose parent was not walked is left out.
    const children = new Map<string, string[]>();
    for (const [id, node] of walk.nodes) if (!walk.tops.has(id)) children.set(node.parent, [...children.get(node.parent) ?? [], id]);
    const queue = [...walk.tops.keys()];
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      for (const id of children.get(parent) ?? []) {
        if (paths.has(id)) continue;
        const node = walk.nodes.get(id)!, path = `${paths.get(parent)}/${node.name}`;
        paths.set(id, path);
        insert.run(id, node.name, parent, path);
        queue.push(id);
      }
    }
    // A chosen department below another chosen one is a top and also a child: link it under its parent.
    const link = db.query("UPDATE directory_departments SET parent = ? WHERE id = ?");
    for (const id of walk.tops.keys()) {
      const parent = walk.nodes.get(id)?.parent;
      if (parent !== undefined && parent !== id && paths.has(parent)) link.run(parent, id);
    }
    const member = db.query("INSERT OR IGNORE INTO directory_department_members (department, phone) VALUES (?, ?)");
    for (const [id, phones] of walk.members) if (paths.has(id)) for (const phone of phones) member.run(id, phone);
    db.query("INSERT INTO directory_tree (singleton, updated_at) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET updated_at = excluded.updated_at").run(now);
  }

  /** 部门树最近一次替换的时间；还没有同步过部门时为 undefined。 */
  get updatedAt(): number | undefined {
    return (this.db.query("SELECT updated_at AS at FROM directory_tree WHERE singleton = 1").get() as { at: number } | null)?.at;
  }

  get(id: string): Department | undefined {
    return this.db.query("SELECT id, name, parent, path FROM directory_departments WHERE id = ?").get(id) as Department | null ?? undefined;
  }

  all(): Department[] {
    return this.db.query("SELECT id, name, parent, path FROM directory_departments ORDER BY path").all() as Department[];
  }

  /** 这些部门的路径；树里没有的不列出。 */
  paths(ids: readonly string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db.query("SELECT id, path FROM directory_departments WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: string; path: string }[];
    return new Map(rows.map(row => [row.id, row.path]));
  }

  /**
   * 按名称或路径找部门（不计空白）：名称相同，或完整路径相同，或路径以“/名称”结尾（“技术部/研发组”找到“公司/技术部/研发组”）。
   * 找不到时 `similar` 给出名称或路径里含这几个字的部门（最多 10 个）。
   */
  find(query: string): { matches: Department[]; similar: Department[] } {
    const wanted = compact(query).replace(/^\/+|\/+$/g, "");
    if (!wanted) return { matches: [], similar: [] };
    const all = this.all();
    const matches = all.filter(department => {
      const name = compact(department.name), path = compact(department.path);
      return name === wanted || path === wanted || path.endsWith(`/${wanted}`);
    });
    if (matches.length) return { matches, similar: [] };
    return { matches, similar: all.filter(department => compact(department.path).includes(wanted)).slice(0, 10) };
  }

  /** 部门本身及其全部下级部门的 ID。 */
  subtree(id: string): string[] {
    return (this.db.query(`WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT d.id FROM directory_departments d JOIN sub ON d.parent = sub.id)
      SELECT id FROM sub WHERE id IN (SELECT id FROM directory_departments)`).all(id) as { id: string }[]).map(row => row.id);
  }

  /** `id` 是 `ancestors` 中某个部门本身或其下级。 */
  within(id: string, ancestors: readonly string[]): boolean {
    for (let current = this.get(id), depth = 0; current && depth < 64; current = current.parent === null ? undefined : this.get(current.parent), depth++) {
      if (ancestors.includes(current.id)) return true;
    }
    return false;
  }

  /** 这些部门（`children` 时含下级）里有有效映射的成员，按手机号去重。 */
  members(ids: readonly string[], children: boolean): DirectoryIdentity[] {
    const departments = children ? [...new Set(ids.flatMap(id => this.subtree(id)))] : [...ids];
    if (!departments.length) return [];
    return this.db.query(`SELECT DISTINCT m.phone, m.im_user_id AS imUserId, m.name FROM directory_department_members dm
      JOIN member_directory m ON m.phone = dm.phone WHERE dm.department IN (SELECT value FROM json_each(?)) ORDER BY m.name, m.phone`)
      .all(JSON.stringify(departments)) as DirectoryIdentity[];
  }

  /** 同步范围内全部有有效映射的成员。 */
  everyone(): DirectoryIdentity[] {
    return this.db.query("SELECT phone, im_user_id AS imUserId, name FROM member_directory ORDER BY name, phone").all() as DirectoryIdentity[];
  }
}

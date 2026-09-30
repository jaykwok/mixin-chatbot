import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

// The service identity library (scripts/lib/service-user.sh), the deployment's choice of identity (deploy.sh) and the
// operations entry's guard for one-off containers (ops.sh), with Docker, id, stat, chown and flock stubbed; the scenarios
// are in tests/helpers/service-user-cases.sh.
const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const available = !!bash && existsSync(bash);
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const cases = posixPath(join(project, "tests/helpers/service-user-cases.sh"));

async function scenarios(group: string, root: string) {
  const child = Bun.spawn([bash!, cases, group, posixPath(root)], {
    cwd: root, env: { ...process.env, MIXIN_OPS_TUI: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, out + err).toBe(0);
  const results: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) results[line.slice(0, at)] = line.slice(at + 1);
  }
  return { results, message: (name: string) => readFile(join(root, `${name}.err`), "utf8") };
}

test.skipIf(!available)("服务身份记录：写入前校验再改名，读取拒绝缺失、重复、未知或无效的内容", async () => {
  const fixture = await tempFixture("service-user-record-");
  const read = join(fixture.root, "record/read");
  const records: Record<string, string> = {
    valid: "format=1\nuser=1000:1000\nsource=container\n",
    confirmed: "format=1\nuser=0:0\nsource=confirmed\n",
    "no-final-newline": "format=1\nuser=1000:1000\nsource=default",
    missing: "format=1\nuser=1000:1000\n",
    duplicate: "format=1\nuser=1000:1000\nsource=container\nuser=1001:1001\n",
    extra: "format=1\nuser=1000:1000\nsource=container\nimage=mixin-chatbot\n",
    named: "format=1\nuser=appuser\nsource=container\n",
    "leading-zero": "format=1\nuser=01000:1000\nsource=container\n",
    "format-2": "format=2\nuser=1000:1000\nsource=container\n",
    guessed: "format=1\nuser=1000:1000\nsource=guessed\n",
    crlf: "format=1\r\nuser=1000:1000\r\nsource=container\r\n",
    "no-equals": "format\nformat=1\nuser=1000:1000\nsource=container\n",
    "empty-key": "=x\nformat=1\nuser=1000:1000\nsource=container\n",
  };
  try {
    for (const [name, content] of Object.entries(records)) {
      await mkdir(join(read, name), { recursive: true });
      await writeFile(join(read, name, "service-user"), content);
    }
    await mkdir(join(read, "absent"), { recursive: true });
    await mkdir(join(read, "directory/service-user"), { recursive: true });
    if (process.platform !== "win32") {
      await mkdir(join(read, "link"), { recursive: true });
      await symlink(join(read, "valid/service-user"), join(read, "link/service-user"));
    }
    const { results, message } = await scenarios("record", fixture.root);
    expect({ write: results.write, tmp: results["write-tmp-left"], read: results["read-written"], value: results["read-written-value"] })
      .toEqual({ write: "0", tmp: "no", read: "0", value: "1000:1000|container" });
    expect(await readFile(join(fixture.root, "record/written/service-user"), "utf8")).toBe("format=1\nuser=1000:1000\nsource=container\n");
    if (process.platform !== "win32") expect((await stat(join(fixture.root, "record/written/service-user"))).mode & 0o777).toBe(0o600);
    // Refused values never reach the disk.
    expect([results["write-bad-user"], results["write-bad-source"], results["refused-left"]]).toEqual(["1", "1", "0"]);
    expect(await message("write-bad-user")).toContain("服务身份无效：appuser");

    const accepted: Record<string, string> = { valid: "1000:1000|container", confirmed: "0:0|confirmed", "no-final-newline": "1000:1000|default" };
    const names = [...Object.keys(records), "absent", "directory", ...(process.platform === "win32" ? [] : ["link"])];
    for (const name of names) {
      expect({ name, code: results[`read-${name}`], left: results[`left-${name}`] })
        .toEqual({ name, code: name in accepted ? "0" : "1", left: accepted[name] ?? "|" });
    }
    expect(await message("read-absent")).toContain("缺少服务身份记录");
    expect(await message("read-directory")).toContain("不是普通文件");
    if (process.platform !== "win32") expect(await message("read-link")).toContain("不是普通文件");
    expect(await message("read-missing")).toContain("缺少：source");
    expect(await message("read-duplicate")).toContain("服务身份记录无效：user");
    expect(await message("read-empty-key")).not.toContain("bad array subscript");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("身份取值和 Docker 模式：rootless 只用 0:0，rootful 不以 root 运行；rootful 的部署要求 root，rootless 不能用 root", async () => {
  const fixture = await tempFixture("service-user-identity-");
  try {
    const { results, message } = await scenarios("identity", fixture.root);
    const users = ["1000:1000", "0:0", "1001:0", "4294967294:4294967294", "4294967295:0", "0:4294967295", "01000:1000", "1000", "appuser",
      "1000:1000:1", "-1:0", " 1000:1000", ""];
    expect(Object.fromEntries(users.map(user => [user, results[`user:${user}`]]))).toEqual(Object.fromEntries(users.map((user, index) => [user, index < 4 ? "0" : "1"])));
    expect(results["user-newline"]).toBe("1");
    expect(["container", "default", "confirmed", "guessed", ""].map(source => results[`source:${source}`])).toEqual(["0", "0", "0", "1", "1"]);
    expect([results["format:1"], results["format:2"], results["image:1000:1000"]]).toEqual(["0", "1", "1"]);

    expect({
      rootlessRoot: results["fits-rootless-root"], rootlessUser: results["fits-rootless-user"], rootfulUser: results["fits-rootful-user"],
      rootfulGroup: results["fits-rootful-root-group"], rootfulRoot: results["fits-rootful-root"], rootfulRootUser: results["fits-rootful-root-user"],
    }).toEqual({ rootlessRoot: "0", rootlessUser: "1", rootfulUser: "0", rootfulGroup: "0", rootfulRoot: "1", rootfulRootUser: "1" });
    expect(await message("fits-rootless-user")).toContain("从属 ID");
    expect([results["default-rootless"], results["default-rootful"]]).toEqual(["0:0:0", "0:1001:1001"]);

    expect({
      rootfulRoot: results["operator-rootful-root"] + "/" + results["operator-rootful-root-mode"], rootfulUser: results["operator-rootful-user"],
      rootlessUser: results["operator-rootless-user"] + "/" + results["operator-rootless-user-mode"], rootlessRoot: results["operator-rootless-root"],
    }).toEqual({ rootfulRoot: "0/0", rootfulUser: "1", rootlessUser: "0/1", rootlessRoot: "1" });
    // Each refusal names the command to run again and never retries with sudo by itself.
    expect(await message("operator-rootful-user")).toContain("sudo scripts/ops/ops.sh update");
    expect(await message("operator-rootful-user")).toContain("UID 1000");
    expect(await message("operator-rootless-root")).toContain("不要用 sudo");
    expect(await message("operator-rootless-root")).toContain("ops.sh rollback");

    expect([results["recorded-none"], results["recorded-mode"]]).toEqual(["1", "0"]);
    expect({
      rootful: results["data-rootful"], rootfulRoot: results["data-rootful-root"], missing: results["data-missing"],
      rootless: results["data-rootless"], rootlessOther: results["data-rootless-other"],
    }).toEqual({ rootful: "0:1000:1000", rootfulRoot: "1:", missing: "1:", rootless: "0:0:0", rootlessOther: "1:" });
    expect(await message("data-rootless-other")).toContain("不是运行 rootless Docker 的当前用户");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("原容器的身份：只认本项目的数据挂载和数值 UID:GID，不能确定就不设置；一次性容器和配置校验用服务身份", async () => {
  const fixture = await tempFixture("service-user-container-");
  try {
    const { results, message } = await scenarios("container", fixture.root);
    expect([results.read, results["read-fields"], results["read-missing"], results["read-down"]])
      .toEqual(["0", "c0ffee|1000:1000|sha256:old|/srv/groups", "2", "1"]);
    // A missing container is a status for the caller, not an error; an unreachable daemon is reported.
    expect(await message("read-missing")).toBe("");
    expect(await message("read-down")).toContain("无法读取原容器 mixin-chatbot");

    const identities: Record<string, string> = {
      rootful: "1000:1000|container", "rootful-dotted": "1000:1000|container", rootless: "0:0|container",
      "foreign-data": "|", "no-data": "|", "image-user": "|", "named-user": "|", "rootful-root": "|", "rootless-user": "|",
    };
    expect(Object.fromEntries(Object.keys(identities).map(name => [name, results[`from-${name}`] + " " + results[`from-${name}-value`]])))
      .toEqual(Object.fromEntries(Object.entries(identities).map(([name, user]) => [name, (user === "|" ? "1" : "0") + " " + user])));
    expect(await message("from-foreign-data")).toContain("不是本项目的");
    expect(await message("from-no-data")).toContain("未挂载");
    expect(await message("from-image-user")).toContain("镜像默认用户");
    expect(await message("from-named-user")).toContain("appuser");
    expect(await message("from-rootful-root")).toContain("不应以 root");

    expect({
      container: results["one-off-container"], named: results["one-off-named"], owner: results["one-off-owner"],
      rootless: results["one-off-rootless"], unreadable: results["one-off-unreadable"],
    }).toEqual({ container: "0:1000:1000", named: "0:1234:1234", owner: "0:1234:1234", rootless: "0:0:0", unreadable: "1:" });
    expect([results["validate-default"], results["validate-pinned"], results["validate-unreadable"]]).toEqual(["0", "0", "1"]);
    // Offline and read-only, as the service identity; a deployment passes its image ID and identity.
    const check = "-v <p>/data:/app/data:ro {image} bun run scripts/config/validate-models.ts /app;";
    expect(results["validate-runs"]).toBe(
      "run --rm --network none --user 1234:1234 " + check.replace("{image}", "mixin-chatbot") +
      "run --rm --network none --user 1000:1000 " + check.replace("{image}", "sha256:" + "c".repeat(64)));
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("部署确定服务身份：沿用原容器；从未部署用默认值；原容器不在时按数据属主请操作者确认；不能确定就停止", async () => {
  const fixture = await tempFixture("service-user-deploy-");
  try {
    const { results, message } = await scenarios("deploy", fixture.root);
    const expected: Record<string, [string, string, string]> = {
      container: ["0", "1000:1000|container", "0"],
      unclear: ["1", "|", "0"],
      down: ["1", "|", "0"],
      "rollback-left": ["1", "|", "0"],
      first: ["0", "1001:1001|default", "0"],
      "first-rootless": ["0", "0:0|default", "0"],
      declined: ["1", "|", "1"],
      confirmed: ["0", "1000:1000|confirmed", "1"],
      "root-owned": ["1", "|", "0"],
      "confirmed-rootless": ["0", "0:0|confirmed", "1"],
    };
    expect(Object.fromEntries(Object.keys(expected).map(name =>
      [name, [results[`deploy-${name}`], results[`deploy-${name}-user`], results[`deploy-${name}-questions`]]]))).toEqual(expected);
    expect(await message("deploy-unclear")).toContain("无法可靠确定原服务的运行身份");
    expect(await message("deploy-down")).toContain("无法读取原容器");
    expect(await message("deploy-rollback-left")).toContain("mixin-chatbot-rollback");
    expect(results["deploy-declined-question"]).toContain("1000:1000");
    expect(results["deploy-declined-question"]).toContain("已有数据的属主不变");
    expect(await message("deploy-declined")).toContain("未确认服务的运行身份");
    expect(await message("deploy-root-owned")).toContain("不应以 root");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("只把本次新建的目录和本次日志交给服务身份，不递归改动已有数据；普通用户不改属主", async () => {
  const fixture = await tempFixture("service-user-files-");
  try {
    const { results } = await scenarios("files", fixture.root);
    expect({ make: results.make, dirs: results["make-dirs"], chowns: results["make-chowns"] }).toEqual({
      make: "0", dirs: "yes",
      // The highest directory created now, recursively: it holds nothing but the directories just made.
      chowns: "-R -- 1000:1000 <p>/backup/snapshots;-R -- 1000:1000 <p>/backup/rm;-R -- 1000:1000 <p>/new;",
    });
    expect([results["make-existing"], results["make-existing-chowns"], results["make-chown-fails"]]).toEqual(["0", "", "1"]);
    expect([results["make-user"], results["make-user-dirs"], results["make-user-chowns"]]).toEqual(["0", "yes", ""]);
    expect([results.grant, results["grant-chowns"], results["grant-user"], results["grant-user-chowns"]])
      .toEqual(["0", "-- 1000:1000 <p>/a <p>/b;", "0", ""]);
    expect({ log: results["log-chowns"], link: results["log-link-chowns"], none: results["log-none"] + results["log-none-chowns"] }).toEqual({
      log: "-- 1000:1000 <p>/logs <p>/logs/operation.log;", link: "-- 1000:1000 <p>/logs <p>/logs/operations;", none: "0",
    });
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("运维的一次性容器先取得部署锁并拒绝未完成的事务；体检只看锁和事务，不持有锁；git 不信任他人的检出时说明原因，不代为信任", async () => {
  const fixture = await tempFixture("service-user-guard-");
  try {
    const { results, message } = await scenarios("guard", fixture.root);
    expect({ clear: results["guard-clear"], busy: results["guard-busy"], deploy: results["guard-deploy"], update: results["guard-update"] })
      .toEqual({ clear: "0", busy: "1", deploy: "1", update: "1" });
    expect(await message("guard-busy")).toContain("部署或升级正在进行");
    expect(await message("guard-deploy")).toContain("ops.sh resume");
    expect(await message("guard-update")).toContain("ops.sh rollback");
    expect({
      none: results["busy-none"], free: results["busy-free"], held: results["busy-held"], own: results["busy-own"], pointer: results["busy-pointer"],
    }).toEqual({ none: "1", free: "1", held: "0", own: "1", pointer: "0" });
    // root and a checkout of the docker group user who deployed it: the operator decides to trust it, not the script.
    expect([results["git-foreign"], results["git-none"], results["git-ok"]]).toEqual(["1", "1", "0"]);
    expect(await message("git-foreign")).toContain("的 git 仓库属于 jay");
    expect(await message("git-foreign")).toContain("git config --global --add safe.directory");
    expect(await message("git-none")).toContain("不是 git 仓库");
  } finally { await fixture.cleanup(); }
}, 30000);

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTransactionRecord } from "../../scripts/ops/tui/transaction.ts";
import { tempFixture } from "../helpers/temp.ts";

// The candidate image library (scripts/lib/candidate-image.sh) with Docker and the filesystem stubbed; the scenarios
// are in tests/helpers/candidate-image-cases.sh. tests/ops/real-docker-image.test.ts checks the same functions against a
// real Docker Engine.
const project = fileURLToPath(new URL("../../", import.meta.url));
// Candidate images and daemon storage checks belong to the Linux Docker deployment path.
const bash = process.platform === "linux" ? Bun.which("bash") : null;
const available = !!bash && existsSync(bash);
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const cases = posixPath(join(project, "tests/helpers/candidate-image-cases.sh"));

// Git Bash converts the fixture paths only for git, the one native program the scenarios run; keep that conversion on.
async function scenarios(group: string, root: string) {
  const { MSYS_NO_PATHCONV: _, ...env } = process.env;
  const child = Bun.spawn([bash!, cases, group, posixPath(root)], {
    cwd: root, env: { ...env, DOCKER_HOST: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true,
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

const candidate = {
  format: "1", source: "commit", target_sha: "a".repeat(40), image_id: "sha256:" + "b".repeat(64),
  image_tag: "mixin-chatbot:candidate-0123456789ab-0123456789abcdef", daemon_id: "5eec1de4-4518-46da-a461-80c0866ec11d",
  project_id: "0123456789ab", operation_id: "0123456789abcdef",
};
const serialize = (value: Record<string, string>) => Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") + "\n";

test.skipIf(!available)("候选镜像记录：写入前逐项校验再原子改名，读取拒绝缺失、重复、未知或不一致的内容", async () => {
  const fixture = await tempFixture("candidate-record-");
  const read = join(fixture.root, "record/read");
  const { operation_id: _, ...missing } = candidate;
  const records: Record<string, string> = {
    valid: serialize(candidate),
    "legacy-daemon-id": serialize({ ...candidate, daemon_id: "ABCD:EFGH:IJKL:MNOP:QRST:UVWX:YZ23:4567:ABCD:EFGH:IJKL:MNOP" }),
    "workspace-sha256": serialize({ ...candidate, source: "workspace", target_sha: "c".repeat(64) }),
    // A standalone deployment may build from an unpacked directory that is not a git repository; a commit build may not.
    "workspace-no-commit": serialize({ ...candidate, source: "workspace", target_sha: "" }),
    "commit-no-commit": serialize({ ...candidate, target_sha: "" }),
    "no-final-newline": serialize(candidate).trimEnd(),
    extra: serialize(candidate) + "note=1\n",
    duplicate: serialize(candidate) + `image_id=sha256:${"c".repeat(64)}\n`,
    missing: serialize(missing),
    "short-id": serialize({ ...candidate, image_id: "sha256:abc" }),
    "upper-id": serialize({ ...candidate, image_id: "sha256:" + "B".repeat(64) }),
    "other-project": serialize({ ...candidate, project_id: "ffffffffffff" }),
    "floating-tag": serialize({ ...candidate, image_tag: "mixin-chatbot:latest" }),
    "bad-source": serialize({ ...candidate, source: "tag" }),
    "bad-daemon": serialize({ ...candidate, daemon_id: "not a daemon" }),
    crlf: serialize(candidate).replaceAll("\n", "\r\n"),
    "empty-key": "=x\n" + serialize(candidate),
    "no-equals": "format\n" + serialize(candidate),
  };
  try {
    for (const [name, content] of Object.entries(records)) {
      await mkdir(join(read, name), { recursive: true });
      await writeFile(join(read, name, "candidate-image"), content);
    }
    await mkdir(join(read, "absent"), { recursive: true });
    await mkdir(join(read, "directory/candidate-image"), { recursive: true });
    if (process.platform !== "win32") {
      await mkdir(join(read, "link"), { recursive: true });
      await symlink(join(read, "valid/candidate-image"), join(read, "link/candidate-image"));
    }
    const { results, message } = await scenarios("record", fixture.root);

    // Written in key order, complete and readable back; the temporary file is gone after the rename.
    expect({ write: results.write, tmp: results["write-tmp-left"], read: results["read-written"], tag: results["read-written-tag"] })
      .toEqual({ write: "0", tmp: "no", read: "0", tag: candidate.image_tag });
    expect(await readFile(join(fixture.root, "record/written/candidate-image"), "utf8")).toBe(serialize(candidate));
    if (process.platform !== "win32") expect((await stat(join(fixture.root, "record/written/candidate-image"))).mode & 0o777).toBe(0o600);
    // Refused values never reach the disk, not even as a temporary file.
    expect([results["write-bad-id"], results["write-missing-key"], results["write-tag-mismatch"], results["refused-left"]]).toEqual(["1", "1", "1", "0"]);
    expect(await message("write-missing-key")).toContain("缺少：daemon_id");
    expect(await message("write-tag-mismatch")).toContain("不一致");

    const accepted = ["valid", "legacy-daemon-id", "workspace-sha256", "workspace-no-commit", "no-final-newline"];
    const names = [...Object.keys(records), "absent", "directory", ...(process.platform === "win32" ? [] : ["link"])];
    for (const name of names) {
      expect({ name, code: results[`read-${name}`] }).toEqual({ name, code: accepted.includes(name) ? "0" : "1" });
      if (!accepted.includes(name)) expect({ name, left: results[`left-${name}`] }).toEqual({ name, left: "0" });
    }
    expect(await message("read-absent")).toContain("缺少候选镜像记录");
    expect(await message("read-directory")).toContain("不是普通文件");
    if (process.platform !== "win32") expect(await message("read-link")).toContain("不是普通文件");
    expect(await message("read-missing")).toContain("缺少：operation_id");
    expect(await message("read-other-project")).toContain("不一致");
    expect(await message("read-duplicate")).toContain("候选镜像记录无效：image_id");
    expect(await message("read-commit-no-commit")).toContain("缺少提交");
    // An empty key is refused as invalid, never used as an array subscript.
    expect(await message("read-empty-key")).not.toContain("bad array subscript");
  } finally { await fixture.cleanup(); }
}, 30000);

// The recovery entry reads the transaction record with the checked-out code. During the first upgrade to a version with
// candidate images the checkout is still the old one (98f1b4a): its Bash and TUI parsers accept exactly these keys and
// format 1. Image identity lives in candidate-image beside the record instead.
test.skipIf(!available)("事务记录保持 format 1、键集合不变：首次过渡时旧版恢复入口仍能读取", async () => {
  const frozen = ["format", "operation", "snapshot", "target_sha", "original_sha", "original_branch", "original_group_root",
    "target_group_root", "was_running", "bot_port", "deploy_mode", "bot_domain", "domain_action", "unmanaged_tunnel", "platform_ip", "reconfigure_ai"];
  const fixture = await tempFixture("candidate-format-");
  try {
    const { results } = await scenarios("format", fixture.root);
    expect({ keys: results.keys, format1: results["format-1"], format2: results["format-2"], imageKey: results["candidate-key"] })
      .toEqual({ keys: frozen.join(" "), format1: "0", format2: "1", imageKey: "1" });
    const record = Object.fromEntries(frozen.map(key => [key, ""])) as Record<string, string>;
    Object.assign(record, { format: "1", operation: "upgrade", snapshot: "deploy-abc123", target_sha: "a".repeat(40), original_sha: "b".repeat(40),
      original_branch: "main", original_group_root: "/srv/groups", target_group_root: "/srv/groups", was_running: "1", bot_port: "2022",
      deploy_mode: "direct", domain_action: "keep", platform_ip: "203.0.113.17", reconfigure_ai: "0" });
    expect(Object.keys(parseTransactionRecord(serialize(record)))).toEqual(frozen);
    expect(() => parseTransactionRecord(serialize({ ...record, format: "2" }))).toThrow();
    expect(() => parseTransactionRecord(serialize({ ...record, image_id: candidate.image_id }))).toThrow();
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("构建上下文只来自固定提交：工作区改动、暂存和未跟踪文件都不进入镜像", async () => {
  const fixture = await tempFixture("candidate-export-");
  try {
    const { results, message } = await scenarios("export", fixture.root);
    expect({ code: results.export, a: results["exported-a"], files: results["exported-files"] })
      .toEqual({ code: "0", a: "committed", files: "./.dockerignore ./Dockerfile ./src/a.txt " });
    expect([results["export-existing"], results["export-ref"], results["export-unknown"], results["export-no-dockerfile"]]).toEqual(["1", "1", "1", "1"]);
    expect(await message("export-existing")).toContain("构建目录已存在");
    expect(await message("export-ref")).toContain("构建提交无效：HEAD");
    expect(await message("export-unknown")).toContain("无法从提交 ccccccc 导出构建上下文");
    expect(await message("export-no-dockerfile")).toContain("没有 Dockerfile");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("候选镜像按 ID 构建和核对：daemon、归属、平台和保留标签分别报告；保留标签只在仍指向本次镜像时移除", async () => {
  const fixture = await tempFixture("candidate-docker-");
  const b = candidate.image_id, c = "sha256:" + "c".repeat(64);
  try {
    const { results, message } = await scenarios("docker", fixture.root);
    // One build with the reserved tag and the ownership labels; the ID comes from --iidfile, the official tag is untouched.
    expect({ code: results.build, id: results["build-id"], tagged: results.tagged }).toEqual({ code: "0", id: b, tagged: b });
    expect(results["build-call"]).toContain(`build --iidfile `);
    expect(results["build-call"]).toContain(`--tag ${candidate.image_tag} --label org.opencontainers.image.revision=${"a".repeat(40)} ` +
      "--label org.mixin-chatbot.project=0123456789ab --label org.mixin-chatbot.operation=0123456789abcdef --label org.mixin-chatbot.source=commit");
    expect(results["build-call"]).not.toMatch(/--tag mixin-chatbot( |$)/);
    expect([results["build-failed"], results["build-failed-id"], results["build-bad-iid"], results["build-bad-iid-id"]]).toEqual(["1", "", "1", ""]);
    expect(await message("build-bad-iid")).toContain("没有给出有效的镜像 ID：not-an-id");

    expect({
      ok: results.verify, daemon: results["verify-daemon"], arch: results["verify-arch"], owner: results["verify-owner"],
      moved: results["verify-tag-moved"], gone: results["verify-tag-gone"], missing: results["verify-missing"], down: results["verify-down"],
    }).toEqual({ ok: "0", daemon: "3", arch: "5", owner: "5", moved: "6", gone: "6", missing: "4", down: "1" });
    expect(await message("verify-daemon")).toContain("Docker daemon 已切换");
    expect(await message("verify-tag-moved")).toContain("执行仍只按记录的 ID");
    expect(await message("verify-missing")).toContain("已不存在");

    expect({ code: results.publish, published: results.published, unverified: results["publish-unverified"] }).toEqual({ code: "0", published: b, unverified: "1" });
    expect(await message("publish-unverified")).toContain(`没有指向候选镜像 ${c}`);
    // A moved tag is kept; the reserved tag is removed by name only, so the image keeps its official tag.
    expect({ moved: results["release-moved"], kept: results["release-moved-tag"] }).toEqual({ moved: "2", kept: c });
    expect({ code: results.release, left: results["release-tag-left"], published: results["release-published"] }).toEqual({ code: "0", left: "no", published: b });
    expect({ absent: results["release-absent"], down: results["release-down"], removals: results["rm-calls"] }).toEqual({ absent: "0", down: "1", removals: "1" });
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("存储位置只认本机 daemon，rootful 只让 root 查看；containerd 只看 root 或当前用户的进程和可信程序，位置按有效配置和挂载表确定，由数据库锁确认进程", async () => {
  const fixture = await tempFixture("candidate-storage-");
  const at = (path: string) => posixPath(join(fixture.root, path));
  const docker = at("disk1/docker"), system = at("disk2/containerd");
  try {
    const { results, message } = await scenarios("storage", fixture.root);
    expect([results["storage-tcp"], results["storage-ssh"], results["storage-other-host"]]).toEqual(["1", "1", "1"]);
    expect(await message("storage-tcp")).toContain("不是本机 socket（tcp://10.0.0.2:2376）");
    expect(await message("storage-ssh")).toContain("ssh://ops@example.invalid");
    expect(await message("storage-other-host")).toContain("otherhost");
    expect({ code: results["storage-classic"], paths: results["storage-classic-paths"] }).toEqual({ code: "0", paths: docker });
    // A rootful daemon is looked at by root only; any other user is refused before anything is looked at. The other
    // cases are a rootless daemon looked at by its own user.
    const rootful = "Docker 以 root 身份运行（rootful），它的数据目录只有 root 能完整查看，当前用户（UID 1000）确认不了镜像存储在哪块磁盘上；请改用 root 运行\n";
    expect({
      user: results["storage-rootful-user"], containerd: results["storage-rootful-containerd"],
      root: results["storage-rootful-root"], paths: results["storage-rootful-root-paths"],
    }).toEqual({ user: "1", containerd: "1", root: "0", paths: docker });
    expect([await message("storage-rootful-user"), await message("storage-rootful-containerd")]).toEqual([rootful, rootful]);
    if (process.platform === "linux") {
      expect({ code: results["storage-docker-relocated"], paths: results["storage-docker-relocated-paths"] })
        .toEqual({ code: "0", paths: `${docker} ${at("disk3/overlay2")}` });
    } else expect(results["storage-docker-relocated"]).toBe("skipped");
    // Finding those links needs to enter and list the Docker root: 000, 0300 (search only) and 0600 (list only) are
    // refused before looking, and a listing that fails anyway is refused too.
    const modes = ["000", "300", "600"].map(mode => `storage-docker-mode-${mode}`);
    if (process.platform === "linux" && process.getuid?.() !== 0) {
      const unreadable = `当前用户无法列出并进入 Docker 数据目录 ${docker}，确认不了镜像存储在哪块磁盘上\n`;
      expect(await Promise.all(modes.map(async name => [results[name], await message(name)])))
        .toEqual(modes.map(() => ["1", unreadable]));
    } else expect(modes.map(name => results[name])).toEqual(modes.map(() => "skipped"));
    expect(results["storage-docker-unlisted"]).toBe("1");
    expect(await message("storage-docker-unlisted")).toBe(`列不出 Docker 数据目录 ${docker} 的内容，确认不了镜像存储在哪块磁盘上\n`);
    expect([results["storage-no-address"], results["storage-devmapper"]]).toEqual(["1", "1"]);
    expect(await message("storage-no-address")).toContain("没有报告 containerd 的地址");
    expect(await message("storage-devmapper")).toContain("快照器 devmapper");

    // The process whose effective address is Docker's, confirmed by its lock on meta.db; the rootless containerd, locking
    // its own database under <DockerRootDir>/containerd/daemon on another address, and the shim are not chosen.
    expect({ code: results["storage-system"], paths: results["storage-system-paths"] }).toEqual({ code: "0", paths: `${docker} ${system}` });
    const refused = {
      otherInode: results["storage-other-inode"], noDatabase: results["storage-no-database"],
      extraDisk: results["storage-extra-disk"], unknownDevice: results["storage-unknown-device"],
    };
    expect(refused).toEqual({ otherInode: "1", noDatabase: "1", extraDisk: "1", unknownDevice: "1" });
    expect(await message("storage-other-inode")).toContain(`PID 100：没有锁定 ${system}/io.containerd.metadata.v1.bolt/meta.db`);
    expect(await message("storage-no-database")).toContain(`PID 100：读不到 ${system}/io.containerd.metadata.v1.bolt/meta.db，无法核对`);
    expect(await message("storage-extra-disk")).toContain("还在另一个文件系统（8:3，xfs）上保存数据");
    expect(await message("storage-unknown-device")).toContain("在本机看不到的文件系统（0:99）上持有锁");
    expect({ code: results["storage-claimant"], paths: results["storage-claimant-paths"] }).toEqual({ code: "0", paths: `${docker} ${system}` });
    // Version 4 dumps (containerd 2.3 and later) carry the address in the gRPC server plugin's section; the section the
    // dump's version does not use never matches.
    expect({ code: results["storage-version4"], paths: results["storage-version4-paths"] }).toEqual({ code: "0", paths: `${docker} ${system}` });
    expect([results["storage-version4-leftover"], results["storage-version3-plugin"]]).toEqual(["1", "1"]);
    const unserved = "找不到为 Docker 服务的 containerd（地址 /run/containerd/containerd.sock）";
    expect(await message("storage-version4-leftover")).toContain(unserved);
    expect(await message("storage-version3-plugin")).toContain(unserved);

    // Locations come from the mount table: a disk mounted on the content store counts without holding any lock, as does
    // one inside the Docker root; runtime overlay/tmpfs mounts and Docker volumes do not.
    const content = "io.containerd.content.v1.content";
    expect({ code: results["storage-nested"], paths: results["storage-nested-paths"] })
      .toEqual({ code: "0", paths: `${docker} ${docker}/buildkit ${system} ${system}/${content}` });
    if (process.platform === "linux") {
      expect({ code: results["storage-relocated"], paths: results["storage-relocated-paths"] })
        .toEqual({ code: "0", paths: `${docker} ${system} ${at("disk3/content")}` });
    } else expect(results["storage-relocated"]).toBe("skipped");
    if (process.platform === "linux" && process.getuid?.() !== 0) {
      expect(results["storage-nested-hidden"]).toBe("1");
      expect(await message("storage-nested-hidden")).toContain(`当前用户无法进入 ${system}/private/blobs（挂在 ${system} 内部的另一个文件系统）`);
    } else expect(results["storage-nested-hidden"]).toBe("skipped");

    expect({ code: results["storage-flags"], paths: results["storage-flags-paths"] }).toEqual({ code: "0", paths: `${docker} ${at("disk3/override")}` });
    expect({ code: results["storage-snapshots"], paths: results["storage-snapshots-paths"] })
      .toEqual({ code: "0", paths: `${docker} ${system} ${at("disk3/snapshots")}` });
    expect([results["storage-snapshots-unused"], results["storage-no-snapshotter"]]).toEqual(["1", "1"]);
    expect(await message("storage-snapshots-unused")).toContain(`没有锁定 ${at("disk3/snapshots")}/metadata.db`);
    expect(await message("storage-no-snapshotter")).toContain("配置中没有快照器 overlayfs");

    // Only processes of root or this user are looked at, and only programs no one else can replace are run: the
    // foreign one never ran, even though the lookup went on to succeed (or, alone, to fail).
    expect({ code: results["storage-foreign"], paths: results["storage-foreign-paths"], alone: results["storage-only-foreign"] })
      .toEqual({ code: "0", paths: `${docker} ${system}`, alone: "1" });
    expect(await message("storage-only-foreign")).toContain("PID 500：属于用户 4242，不是 root 或当前用户，不检查");
    if (process.platform === "linux") expect(results["storage-writable"]).toBe("0");
    else expect(results["storage-writable"]).toBe("skipped");
    // A world-writable directory and a group-writable program are refused; a sticky directory is fine.
    const ran = [at("bin/containerd"), ...(process.platform === "linux" ? [at("sticky/containerd")] : [])].sort();
    expect(results.executions).toBe(ran.join(" ") + " ");

    expect([results["storage-unreadable"], results["storage-no-executable"], results["storage-no-process"], results["storage-root-missing"]])
      .toEqual(["1", "1", "1", "1"]);
    expect(await message("storage-unreadable")).toContain(`找不到为 Docker 服务的 containerd（地址 /run/containerd/containerd.sock）`);
    expect(await message("storage-unreadable")).toContain(`PID 100：无法读取配置 ${at("unreadable.toml")}`);
    expect(await message("storage-no-executable")).toContain("PID 100：找不到它的可执行文件");
  } finally { await fixture.cleanup(); }
}, 90000);

// The imports merge is containerd's own: run the real binary where there is one (Linux hosts with Docker).
const containerd = process.platform === "linux" ? Bun.which("containerd") : null;
test.skipIf(!available || !containerd)("真实 containerd 的 config dump 合并 imports：存储位置跟随导入的根目录，而不是主配置或遗留目录", async () => {
  const fixture = await tempFixture("candidate-containerd-");
  try {
    const { results, message } = await scenarios("containerd", fixture.root);
    expect({ code: results["containerd-real"], err: await message("containerd-real") }).toEqual({ code: "0", err: "" });
    expect(results["containerd-real-paths"]).toBe(`${join(fixture.root, "docker-root")} ${join(fixture.root, "actual-root")}`);
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("磁盘预检按共享剩余空间的单位汇总需求（btrfs 子卷、ZFS 存储池），Docker 存储只算一次构建估算", async () => {
  const fixture = await tempFixture("candidate-disk-");
  try {
    const { results, message } = await scenarios("disk", fixture.root);
    // mountinfo's device is the superblock's, shared by btrfs subvolumes; ZFS datasets group by pool; escaped names are
    // decoded and the topmost of stacked mounts wins.
    expect({
      docker: results["facts-/pool/docker/x"], home: results["facts-/pool/home/x"], tankDocker: results["facts-/tank/docker/x"],
      tankData: results["facts-/tank/data/x"], spaced: results["facts-/srv/with space/x"], unknown: results["facts-/elsewhere"],
    }).toEqual({
      docker: "/var/lib/docker|0:31|btrfs|0:31", home: "/home|0:31|btrfs|0:31", tankDocker: "/tank/docker|0:45|zfs|zfs:tank",
      tankData: "/tank/data|0:46|zfs|zfs:tank", spaced: "/srv/with space|0:52|tmpfs|0:52", unknown: "|||",
    });
    expect({ shared: results["btrfs-shared"], enough: results["btrfs-enough"], zfs: results["zfs-pool"] }).toEqual({ shared: "1", enough: "0", zfs: "1" });
    // The build estimate is needed once per pool, yet a dataset with a smaller quota still limits it.
    expect({ quota: results["zfs-quota"], enough: results["zfs-quota-enough"] }).toEqual({ quota: "1", enough: "0" });
    expect(await message("zfs-quota")).toBe("磁盘空间不足：/tank/docker、/tank/containerd（/tank/docker/root、/tank/containerd/root）可用 954 MiB，需要 3.8 GiB\n");
    expect(await message("btrfs-shared")).toBe("磁盘空间不足：/var/lib/docker、/home（/pool/docker/root、/pool/home/data）可用 4.2 GiB，需要 4.8 GiB\n");
    expect(await message("zfs-pool")).toBe("磁盘空间不足：/tank/docker、/tank/data（/tank/docker/x、/tank/data/x）可用 2.8 GiB，需要 3.3 GiB\n");
    expect([results["disk-separate"], results["disk-short"], results["disk-summed"], results["disk-unknown"]]).toEqual(["0", "1", "1", "1"]);
    expect(await message("disk-short")).toBe("磁盘空间不足：/mnt/1（/fs-a/docker）可用 2.8 GiB，需要 3.3 GiB\n");
    expect(await message("disk-unknown")).toBe("无法确定 /elsewhere 所在的文件系统\n");
    // Two paths on one filesystem: each fits alone, together they do not.
    expect(await message("disk-summed")).toBe("磁盘空间不足：/mnt/1（/fs-a/x、/fs-a/y）可用 2.8 GiB，需要 3.0 GiB\n");
    // 322 MB unpacked is below the 2 GB floor: 2 GB × 1.5 + 1 GiB for Docker, plus the 1 GiB data reserve on the same filesystem.
    expect({ exact: results["build-exact"], short: results["build-short"] }).toEqual({ exact: "0", short: "1" });
    // The containerd root on the same filesystem is checked but adds nothing: 4.8 GiB is one estimate plus the reserve.
    expect(await message("build-short")).toBe("磁盘空间不足：/mnt/1（/fs-a/docker、/fs-a/containerd、/fs-a/data）可用 4.8 GiB，需要 4.8 GiB\n");
    expect({ large: results["build-large"], short: results["build-large-short"], none: results["build-no-previous"] }).toEqual({ large: "0", short: "1", none: "0" });
    expect(results["build-unknown-storage"]).toBe("1");
    expect(await message("build-unknown-storage")).toBe("storage unknown\n");
    expect([results["bytes-322MB"], results["bytes-1.23GB"], results["bytes-976.6kB"], results["bytes-0B"], results["bytes-12XB"], results["bytes-"]])
      .toEqual(["322000000", "1230000000", "976600", "0", "fail", "fail"]);
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("准备候选镜像：本次操作独占保留标签，构建后按 ID 核对；失败不留标签，中断时按操作 ID 认领，别人的镜像不移除", async () => {
  const fixture = await tempFixture("candidate-prepare-");
  const b = candidate.image_id, c = "sha256:" + "c".repeat(64);
  try {
    const { results, message } = await scenarios("prepare", fixture.root);
    expect({ code: results.prepare, record: results["prepare-record"], tag: results["prepare-tag"], tagged: results["prepare-tagged"] })
      .toEqual({ code: "0", record: `commit|${candidate.target_sha}|${b}|${candidate.daemon_id}`, tag: "ours", tagged: b });
    expect({ code: results["prepare-release"], left: results["prepare-release-left"] }).toEqual({ code: "0", left: "no" });
    expect({ code: results.workspace, record: results["workspace-record"], release: results["workspace-release"] })
      .toEqual({ code: "0", record: `workspace||${c}`, release: "0" });
    expect({ code: results.failed, id: results["failed-id"], release: results["failed-release"] }).toEqual({ code: "1", id: "", release: "0" });
    expect(await message("failed")).toContain("候选镜像构建失败");
    expect({ claim: results.claim, left: results["claim-left"] }).toEqual({ claim: "0", left: "no" });
    expect({ foreign: results["claim-foreign"], left: results["claim-foreign-left"] }).toEqual({ foreign: "2", left: "yes" });
    expect(await message("claim-foreign")).toContain("不是本次构建的镜像");
    expect([results.interruptible, results["interruptible-status"], results["interruptible-traps"]]).toEqual(["0", "7", ""]);
    expect([results["interruptible-kept"], results["interruptible-kept-traps"]]).toEqual(["0", "trap -- 'exit 143' SIGTERM"]);
    // Windows cannot deliver the signal to bash.
    if (process.platform !== "win32") expect(results["interruptible-ignored"]).toBe("kept");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!available)("停机前复核：备份目录要放得下停机后的快照，数据、群根和升级器目录各留余量；估算不了就不停机", async () => {
  const fixture = await tempFixture("candidate-snapshot-");
  try {
    const { results, message } = await scenarios("snapshot", fixture.root);
    // Configuration, markers, state databases, group statistics and Durable databases (1,500,000 bytes plus directory entries); group
    // workspaces and other state files (5 MB each) are not copied.
    expect([results["estimate-at-least"], results["estimate-at-most"], results["estimate-empty"]]).toEqual(["yes", "yes", "0"]);
    const reserve = 1073741824;
    expect({ code: results.stop, args: results["stop-args"] })
      .toEqual({ code: "0", args: `<f>/project/backup ${reserve + 5000} <f>/project/data ${reserve} <f>/groups ${reserve}` });
    // Before the first backup the project directory stands in for backup/, which it will be made in.
    expect({ code: results["stop-no-backup"], args: results["stop-no-backup-args"] })
      .toEqual({ code: "0", args: `<f>/project ${reserve + 5000} <f>/project/data ${reserve} <f>/groups ${reserve} <f>/upgrader ${reserve}` });
    expect([results["stop-unknown"], results["stop-unknown-checked"]]).toEqual(["1", "no"]);
    expect(await message("stop-unknown")).toContain("无法估算快照的大小");
  } finally { await fixture.cleanup(); }
}, 30000);

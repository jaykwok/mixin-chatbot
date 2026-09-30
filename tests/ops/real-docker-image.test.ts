// Opt-in check of scripts/lib/candidate-image.sh against a real Docker Engine: build by --iidfile, inspect and run by ID,
// the image a container actually uses, tags kept through the switch and the rollback, a moved reserved tag, the daemon
// identity and the storage locations the disk check measures. It uses its own repository and container names (never the
// mixin-chatbot tag) and synthetic images from the oven/bun base. Run it on a disposable Docker host, once each as a
// docker-group user (the storage lookup must refuse the rootful daemon), as root and against a rootless daemon as the
// user it belongs to (DOCKER_HOST):
// MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker-image.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const library = join(project, "scripts/lib/candidate-image.sh");
const enabled = process.env.MIXIN_REAL_DOCKER === "1" && process.platform === "linux";
const baseImage = /^FROM\s+(oven\/bun:\S+)/m.exec(readFileSync(join(project, "Dockerfile"), "utf8"))?.[1] ?? "";
const passthrough = Object.fromEntries(["HOME", "USER", "PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]!]));

function run(command: string, args: string[], cwd = project) {
  const result = spawnSync(command, args, { cwd, env: { ...passthrough, LANG: "C.UTF-8" }, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
function must(command: string, args: string[], cwd = project): string {
  const result = run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.out}\n${result.err}`);
  return result.out;
}
const docker = (...args: string[]) => run("docker", args);
// Sources the library and runs one of its functions; CANDIDATE_IMAGE_ID is printed after the function's own output.
const RUNNER = '. "$1"; shift; "$@"; status=$?; printf "\\nCANDIDATE_IMAGE_ID=%s\\n" "${CANDIDATE_IMAGE_ID:-}"; exit "$status"';
function lib(...args: string[]) {
  const result = run("bash", ["-c", RUNNER, "candidate-image", library, ...args]);
  const id = /^CANDIDATE_IMAGE_ID=(.*)$/m.exec(result.out)?.[1] ?? "";
  return { ...result, id };
}
// Verifies against a candidate-image record written the way the upgrader writes it.
function verify(directory: string) {
  return run("bash", ["-c", '. "$1"; read_candidate_record "$2" && candidate_verify', "candidate-image", library, directory]);
}
const exists = (reference: string) => docker("image", "inspect", "--format", "{{.Id}}", reference).code === 0;
const tagsOf = (id: string) => {
  const result = docker("image", "inspect", "--format", "{{json .RepoTags}}", id);
  return result.code === 0 ? ((JSON.parse(result.out) as string[] | null) ?? []).sort() : null;
};
const idOf = (reference: string) => docker("image", "inspect", "--format", "{{.Id}}", reference).out;
const usedImage = (container: string) => docker("container", "inspect", "--format", "{{.Image}}", container).out;

describe.skipIf(!enabled)(`real Docker candidate image (uid ${process.getuid?.()})`, () => {
  const suffix = Math.random().toString(16).slice(2, 8);
  const repo = `mixin-image-test-${suffix}`;
  const containers = ["current", "rollback", "verify", "failed"].map(role => `${repo}-${role}`);
  let root = "", repository = "", projectId = "", daemonId = "";
  let failed = false;
  const commits: Record<string, string> = {};
  const images: Record<string, string> = {};
  // Every image this run built, by ID: rollback and a moved tag leave images without any tag, which listing the
  // repository never shows.
  const built: string[] = [];
  let cleaned = false;
  const step = (name: string, body: () => void, timeout = 300_000) => test(name, () => {
    try { body(); } catch (error) { failed = true; throw error; }
  }, timeout);

  const operation = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0") + Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  const tagFor = (op: string) => `${repo}:candidate-${projectId}-${op}`;
  // Exports the commit and builds it the way the upgrader does; returns the ID from --iidfile and the reserved tag.
  function build(commit: string, name: string) {
    const op = operation(), context = join(root, `context-${name}`), tag = tagFor(op);
    const exported = lib("candidate_export_context", repository, commits[commit]!, context);
    expect({ code: exported.code, err: exported.err }).toEqual({ code: 0, err: "" });
    const result = lib("candidate_build", context, tag, commits[commit]!, projectId, op, "commit");
    if (/^sha256:[0-9a-f]{64}$/.test(result.id)) built.push(result.id);
    expect({ code: result.code, err: result.err.slice(-2000) }).toMatchObject({ code: 0 });
    expect(result.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    const record = join(root, `record-${name}`);
    must("mkdir", ["-p", record]);
    writeFileSync(join(record, "candidate-image"), Object.entries({
      format: "1", source: "commit", target_sha: commits[commit]!, image_id: result.id, image_tag: tag, daemon_id: daemonId,
      project_id: projectId, operation_id: op,
    }).map(([key, value]) => `${key}=${value}\n`).join(""));
    return { id: result.id, tag, record };
  }

  // Removes this run's containers and tags, then each image it built, by ID and only while the image still carries this
  // run's project label; never --force, so an image some other container or tag still uses stays. Returns the IDs
  // that are still present.
  function cleanup() {
    cleaned = true;
    for (const name of containers) docker("rm", "-f", name);
    for (const reference of docker("image", "ls", repo, "--format", "{{.Repository}}:{{.Tag}}").out.split("\n").filter(Boolean)) {
      docker("image", "rm", reference);
    }
    for (const id of built) {
      const owner = docker("image", "inspect", "--format", '{{index .Config.Labels "org.mixin-chatbot.project"}}', id);
      if (owner.code === 0 && owner.out === projectId) docker("image", "rm", id);
    }
    return built.filter(exists);
  }

  beforeAll(() => {
    if (!baseImage) throw new Error("Dockerfile has no oven/bun base image");
    const info = docker("info", "--format", "{{.ID}}|{{.ServerVersion}}|{{.DriverStatus}}");
    if (info.code !== 0) throw new Error(`Docker is not reachable: ${info.err}`);
    daemonId = info.out.split("|")[0]!;
    if (!exists(baseImage)) must("docker", ["pull", baseImage]);
    root = mkdtempSync("/var/tmp/mixin-real-docker-image-");
    repository = join(root, "repo");
    must("git", ["init", "-q", "-b", "main", repository]);
    const commit = (name: string, marker: string) => {
      writeFileSync(join(repository, "Dockerfile"), `FROM ${baseImage}\nCOPY marker.txt /marker.txt\nCMD ["cat", "/marker.txt"]\n`);
      writeFileSync(join(repository, "marker.txt"), marker);
      must("git", ["-C", repository, "add", "-A"]);
      must("git", ["-C", repository, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", name]);
      commits[name] = must("git", ["-C", repository, "rev-parse", "HEAD"]);
    };
    commit("old", "old");
    commit("new", "new");
    commit("broken", "broken");
    commit("moved", "moved");
    projectId = must("bash", ["-c", '. "$1"; candidate_project_id "$2"', "candidate-image", library, root]);
    console.log(`real Docker candidate image fixture: ${root} (Docker ${info.out.split("|")[1]}, ${info.out.split("|")[2]}, repository ${repo})`);
  });

  afterAll(() => {
    if (!root) return;
    // The last step cleans up and checks it; this covers runs that stopped earlier.
    const left = cleaned ? built.filter(exists) : cleanup();
    if (left.length) console.log(`real Docker candidate images left behind: ${left.join(" ")}`);
    if (failed || process.env.MIXIN_REAL_DOCKER_KEEP === "1") console.log(`real Docker candidate image fixture kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });

  step("the running deployment's image: built by ID, published and kept under its official and rollback tags", () => {
    const old = build("old", "old");
    images.old = old.id;
    expect(lib("candidate_publish", old.id, `${repo}:current`).code).toBe(0);
    expect(lib("candidate_release_tag", old.tag, old.id).code).toBe(0);
    must("docker", ["run", "-d", "--name", containers[0]!, `${repo}:current`, "sleep", "600"]);
    // The container records the image it actually runs, independent of the tag it was started from.
    expect(usedImage(containers[0]!)).toBe(old.id);
    must("docker", ["tag", old.id, `${repo}:previous`]);
    expect(tagsOf(old.id)).toEqual([`${repo}:current`, `${repo}:previous`]);
  });

  step("a candidate built with --iidfile is the image that inspect reports, runs by ID and is what its container uses", () => {
    const candidate = build("new", "new");
    images.new = candidate.id;
    // The same ID three ways: --iidfile, the reserved tag and the ID itself.
    expect(idOf(candidate.tag)).toBe(candidate.id);
    expect(idOf(candidate.id)).toBe(candidate.id);
    const labels = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Labels}}", candidate.id).out) as Record<string, string>;
    expect(labels).toMatchObject({ "org.opencontainers.image.revision": commits.new, "org.mixin-chatbot.project": projectId, "org.mixin-chatbot.source": "commit" });
    expect(run("docker", ["run", "--rm", candidate.id]).out).toBe("new");
    must("docker", ["create", "--name", containers[2]!, candidate.id]);
    expect(usedImage(containers[2]!)).toBe(candidate.id);
    expect(verify(candidate.record)).toMatchObject({ code: 0, err: "" });
    // Building did not touch the running service or the official tag.
    expect(docker("container", "inspect", "--format", "{{.State.Running}}", containers[0]!).out).toBe("true");
    expect(idOf(`${repo}:current`)).toBe(images.old);
    expect(tagsOf(candidate.id)).toEqual([candidate.tag]);
    images.newTag = candidate.tag;
  });

  step("publishing switches the official tag while every image keeps a tag; releasing the reserved tag keeps the image", () => {
    must("docker", ["stop", "--time", "1", containers[0]!]);
    must("docker", ["rename", containers[0]!, containers[1]!]);
    expect(lib("candidate_publish", images.new!, `${repo}:current`).code).toBe(0);
    expect(tagsOf(images.new!)).toEqual([`${repo}:current`, images.newTag!].sort());
    expect(tagsOf(images.old!)).toEqual([`${repo}:previous`]);
    expect(lib("candidate_release_tag", images.newTag!, images.new!).code).toBe(0);
    expect(tagsOf(images.new!)).toEqual([`${repo}:current`]);
    expect(run("docker", ["run", "--rm", `${repo}:current`]).out).toBe("new");
    // The old image stays under its rollback tag until the deployment is committed and its container removed.
    expect(usedImage(containers[1]!)).toBe(images.old);
    must("docker", ["rm", containers[1]!]);
    must("docker", ["image", "rm", `${repo}:previous`]);
    expect(exists(images.old!)).toBe(false);
    expect(idOf(`${repo}:current`)).toBe(images.new);
  });

  step("a rolled-back candidate loses only its reserved tag; the restored image keeps its tags throughout", () => {
    must("docker", ["tag", images.new!, `${repo}:previous`]);
    const broken = build("broken", "broken");
    must("docker", ["create", "--name", containers[3]!, broken.id]);
    expect(tagsOf(broken.id)).toEqual([broken.tag]);
    expect(tagsOf(images.new!)).toEqual([`${repo}:current`, `${repo}:previous`]);
    // Rollback restores the official tag to the previous image (it never moved here) and drops the candidate's tag.
    expect(lib("candidate_publish", images.new!, `${repo}:current`).code).toBe(0);
    expect(lib("candidate_release_tag", broken.tag, broken.id).code).toBe(0);
    expect(exists(broken.tag)).toBe(false);
    expect(tagsOf(images.new!)).toEqual([`${repo}:current`, `${repo}:previous`]);
    // Whether an untagged image outlives the stopped container that used it depends on the image store; record it.
    console.log(`rolled-back candidate after its tag was released: ${exists(broken.id) ? "still present (container keeps it)" : "removed by the image store"}`);
    must("docker", ["image", "rm", `${repo}:previous`]);
  });

  step("a reserved tag moved to another image is detected, never removed, and execution stays bound to the ID", () => {
    const moved = build("moved", "moved");
    must("docker", ["tag", images.new!, moved.tag]);
    // Losing its only tag can remove the candidate at once (containerd image store): verification then reports it missing.
    const present = exists(moved.id);
    const verified = verify(moved.record);
    expect(verified.code).toBe(present ? 6 : 4);
    console.log(`candidate after its reserved tag moved: ${present ? "still present" : "removed by the image store"}`);
    expect(lib("candidate_release_tag", moved.tag, moved.id).code).toBe(2);
    expect(idOf(moved.tag)).toBe(images.new);
    must("docker", ["image", "rm", moved.tag]);
    expect(idOf(`${repo}:current`)).toBe(images.new);
  });

  step("daemon identity and the storage the disk check measures are this daemon's own", () => {
    expect(must("bash", ["-c", '. "$1"; candidate_daemon_id', "candidate-image", library])).toBe(daemonId);
    const listed = run("bash", ["-c", '. "$1"; docker_storage_paths && printf "%s\\n" "${DOCKER_STORAGE_PATHS[@]}"', "candidate-image", library]);
    const disk = run("bash", ["-c", '. "$1"; check_build_disk_space "$2" "$3"', "candidate-image", library, `${repo}:current`, root]);
    // A rootful daemon's data directories are root's: a docker-group user cannot see what is linked from inside them,
    // so the lookup and the disk check refuse it. A rootless daemon is looked at by the user it belongs to.
    const rootless = must("docker", ["info", "--format", "{{.SecurityOptions}}"]).includes("name=rootless");
    if (!rootless && process.getuid?.() !== 0) {
      const refusal = `Docker 以 root 身份运行（rootful），它的数据目录只有 root 能完整查看，当前用户（UID ${process.getuid?.()}）确认不了镜像存储在哪块磁盘上；请改用 root 运行`;
      expect({ code: listed.code, out: listed.out, err: listed.err }).toEqual({ code: 1, out: "", err: refusal });
      expect({ code: disk.code, err: disk.err }).toEqual({ code: 1, err: refusal });
      return;
    }
    expect({ code: listed.code, err: listed.err }).toEqual({ code: 0, err: "" });
    const paths = listed.out.split("\n");
    const [dockerRoot, status] = must("docker", ["info", "--format", "{{.DockerRootDir}}|{{.DriverStatus}}"]).split("|");
    expect(paths[0]).toBe(dockerRoot);
    const containerd = status!.includes("io.containerd.snapshotter.v1");
    // With containerd: its root, plus a snapshot directory when root_path moves it elsewhere.
    expect(containerd ? paths.length >= 2 && paths.length <= 3 : paths.length === 1).toBe(true);
    if (containerd) {
      // The containerd image store keeps the image's manifest under the content store of the root found (the lookup
      // already checked the serving process's lock on its database), so a wrong choice fails here too.
      accessSync(paths[1]!, constants.R_OK | constants.X_OK);
      expect(existsSync(join(paths[1]!, "io.containerd.content.v1.content/blobs/sha256", images.new!.slice("sha256:".length)))).toBe(true);
    }
    expect({ code: disk.code, err: disk.err }).toEqual({ code: 0, err: "" });
    const short = run("bash", ["-c", '. "$1"; CANDIDATE_IMAGE_MIN_BYTES=1000000000000000000; check_build_disk_space "$2" "$3"', "candidate-image", library, `${repo}:current`, root]);
    expect(short.code).toBe(1);
    expect(short.err).toContain("磁盘空间不足");
  });

  step("cleanup removes every image this run built, including the ones that lost all their tags", () => {
    expect(built.length).toBe(4);
    const untagged = built.filter(id => exists(id) && tagsOf(id)?.length === 0);
    console.log(`images without any tag before cleanup: ${untagged.length}`);
    expect(cleanup()).toEqual([]);
    expect(docker("image", "ls", "--quiet", "--filter", `label=org.mixin-chatbot.project=${projectId}`).out).toBe("");
    // The base image is shared with other work and stays.
    expect(exists(baseImage)).toBe(true);
  });
});

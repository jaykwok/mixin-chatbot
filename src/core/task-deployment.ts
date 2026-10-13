import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/** Trusted deployment manifest: manager paths remain stable while Docker resolves sources on its own host. */
export interface TaskDeployment {
  version: 1;
  image: string;
  mounts: readonly { manager: string; daemon: string }[];
  /** Immutable code/runtime paths already supplied by the same pinned worker image. Never writable. */
  imagePaths: readonly string[];
}

export interface TaskLaunch extends TaskDeployment { controlRoot: string; }

/** Deployment-only input, never a tool argument or an editable model runtime option. */
export function readTaskLaunch(path: string): TaskLaunch {
  absolute(path);
  if (process.platform !== "linux" || realpathSync(path) !== path) throw new Error("任务部署清单必须是 Linux 普通绝对路径");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) throw new Error("任务部署清单必须属于管理身份且权限为 0600");
    const value = JSON.parse(readFileSync(fd, "utf8")) as TaskLaunch;
    const paths = new TaskPaths(value, value.image);
    paths.source(value.controlRoot);
    return value;
  } finally { closeSync(fd); }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

function absolute(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path === "/" || posix.normalize(path) !== path || path.endsWith("/") || /[,\x00-\x1f\x7f]/.test(path)) {
    throw new Error("任务部署路径必须是规范的 Linux 绝对路径，不能是根目录或包含控制字符、逗号");
  }
}

/** Validates and copies the manifest; caller mutations cannot redirect a live backend or its recovery records. */
export class TaskPaths {
  readonly identity: string;
  readonly #mounts: { manager: string; daemon: string }[];
  readonly #imagePaths: string[];

  constructor(deployment: TaskDeployment, image: string) {
    if (deployment.version !== 1 || deployment.image !== image || !/^sha256:[a-f\d]{64}$/.test(image)
      || !Array.isArray(deployment.mounts) || !deployment.mounts.length || !Array.isArray(deployment.imagePaths)) {
      throw new Error("任务部署清单版本、挂载或固定镜像不匹配");
    }
    this.#mounts = deployment.mounts.map(item => {
      if (!item || typeof item !== "object") throw new Error("任务部署挂载无效");
      absolute(item.manager); absolute(item.daemon);
      return { manager: item.manager, daemon: item.daemon };
    }).sort((a, b) => a.manager < b.manager ? -1 : a.manager > b.manager ? 1 : 0);
    this.#imagePaths = [...deployment.imagePaths].map(path => { absolute(path); return path; }).sort();
    for (let i = 0; i < this.#mounts.length; i++) {
      const current = this.#mounts[i]!;
      for (const prior of this.#mounts.slice(0, i)) {
        if (["manager", "daemon"].some(key => {
          const field = key as "manager" | "daemon";
          return inside(current[field], prior[field]) || inside(prior[field], current[field]);
        })) throw new Error("任务部署挂载根不能重复或重叠");
      }
    }
    for (let i = 0; i < this.#imagePaths.length; i++) {
      const path = this.#imagePaths[i]!;
      if (this.#mounts.some(item => inside(path, item.manager) || inside(item.manager, path))
        || this.#imagePaths.slice(0, i).some(prior => inside(path, prior) || inside(prior, path))) {
        throw new Error("镜像内路径不能与部署挂载或其他镜像路径重叠");
      }
    }
    // Receipts bind their own image separately. A code-image upgrade must still recover old work
    // through unchanged filesystem mappings, using the old receipt's image when inspecting writers.
    this.identity = createHash("sha256").update(JSON.stringify({ version: 1, mounts: this.#mounts, imagePaths: this.#imagePaths })).digest("hex");
  }

  source(path: string): string {
    absolute(path);
    const mount = this.#mounts.find(item => inside(path, item.manager));
    if (!mount) throw new Error("任务路径没有登记宿主挂载：" + path);
    return mount.daemon + path.slice(mount.manager.length);
  }

  get roots(): readonly string[] { return this.#mounts.map(item => item.manager); }

  suppliedByImage(path: string): boolean {
    absolute(path);
    return this.#imagePaths.some(root => inside(path, root));
  }
}

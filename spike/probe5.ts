// macOS spike 5 (2026-11-07): where "开头" comes from in a member's bash output (tools.test U+FEFF case).
const raw = String.raw`printf '\357\273\277开头\n'; printf '开头\n'; echo 开头; printf 'a\n\357\273'; printf '\277b\n'`;
const report: Record<string, unknown> = {};
const shells = ["/bin/bash", "/opt/homebrew/bin/bash", "/bin/sh"];
const envs: Record<string, Record<string, string>> = { cutf8: { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" }, enutf8: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, c: { LC_ALL: "C", LANG: "C" }, none: {} };
for (const shell of shells) for (const [label, env] of Object.entries(envs)) {
  const child = Bun.spawn([shell, "-c", raw], { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
  await child.exited;
  report[`${shell} ${label}`] = { text: Buffer.from(out).toString("utf8"), hex: Buffer.from(out).toString("hex").slice(0, 80), err: err.slice(0, 200) };
}
const version = Bun.spawnSync(["/opt/homebrew/bin/bash", "--version"]).stdout.toString().split("\n")[0];
report.brewVersion = version; report.locale = Bun.spawnSync(["locale", "-a"]).stdout.toString().split("\n").filter(l => /^C|POSIX/.test(l));
console.log(JSON.stringify(report, null, 1));
await Bun.write(process.env.SPIKE_REPORT5 ?? "report5.json", JSON.stringify(report, null, 2));

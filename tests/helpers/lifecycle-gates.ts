// An exported fixture hook, never used by the product. The synthetic image's health command reaches this gate.
export const webHealthGate = `{
  const fixtureGateFs = await import("node:fs");
  if (fixtureGateFs.existsSync("data/hold-health") && !fixtureGateFs.existsSync("data/state/verify-only") &&
      !process.argv.includes("--allow-verification") && fixtureGateFs.existsSync("src/upgrade-marker.txt") &&
      fixtureGateFs.existsSync("data/state/release-data.json") &&
      JSON.parse(fixtureGateFs.readFileSync("data/state/release-data.json", "utf8")).phase === "committed" &&
      fixtureGateFs.readFileSync("src/upgrade-marker.txt", "utf8") === fixtureGateFs.readFileSync("data/hold-health", "utf8")) {
    fixtureGateFs.writeFileSync("data/state/health-held", "");
    while (fixtureGateFs.existsSync("data/hold-health")) await Bun.sleep(200);
  }
} // fixture: web health gate`;

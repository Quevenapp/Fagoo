import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
let commit = process.env.WABOTIA_SOURCE_COMMIT || "";
if (!commit && existsSync(".wabotia-source-commit"))
  commit = readFileSync(".wabotia-source-commit", "utf8").trim();
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
}
if (!/^[a-f0-9]{40}$/.test(commit)) commit = "development";
writeFileSync(
  new URL("../src/build-info.generated.ts", import.meta.url),
  `// Generated at build time; do not commit.\nexport const buildInfo = ${JSON.stringify({ version: pkg.version, commit })};\n`,
);

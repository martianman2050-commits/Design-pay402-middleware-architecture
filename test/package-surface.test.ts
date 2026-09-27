// Regression test for the tsx/ESM type-re-export bug (src/index.ts used to
// `export { CoreDecision }` — a type as a named value — which tsc accepted
// but the real Node ESM loader rejected under tsx). We run the fixture in a
// child tsx process and require SURFACE_OK, so a reintroduced bad re-export
// fails the suite exactly where the original bug surfaced: at import time.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixture = resolve(here, "fixtures", "import-surface.ts");
// Run tsx through its ESM CLI with the current Node binary rather than the
// platform .cmd/.bin shim: on Windows, spawning the .cmd triggers Node's
// post-CVE-2024 shell guard (spawn EINVAL). This is shell-free everywhere.
const tsxCli = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

describe("package import surface loads under a real Node ESM loader (tsx)", () => {
  it("imports src/index.ts without a type-as-value re-export error", async () => {
    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number;
    }>((res) => {
      execFile(
        process.execPath,
        [tsxCli, fixture],
        { cwd: repoRoot },
        (err, so, se) => {
          const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          res({ stdout: so, stderr: se, code: exitCode });
        },
      );
    });
    expect(stderr).not.toMatch(/does not provide an export named/);
    expect(code).toBe(0);
    expect(stdout).toContain("SURFACE_OK");
  }, 30_000);
});

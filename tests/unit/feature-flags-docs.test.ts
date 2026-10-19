import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const checker = path.resolve(process.cwd(), "scripts/check-feature-flags-docs.mjs");

function runCheck(root?: string) {
  return spawnSync(process.execPath, [checker, ...(root ? [root] : [])], {
    encoding: "utf8",
  });
}

describe("feature flag documentation CI check", () => {
  it("passes when all source flag keys are documented", () => {
    const result = runCheck();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matches");
  });

  it("fails with a clear message when docs drift from source", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "feature-flag-doc-check-"));
    const sourceDirectory = path.join(root, "src", "lib");
    const docsDirectory = path.join(root, "docs");

    try {
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(docsDirectory, { recursive: true });

      const source = readFileSync(
        path.resolve(process.cwd(), "src/lib/feature-flags.ts"),
        "utf8"
      ).replace(
        "  batch_recheck: {",
        '  ci_test_flag: {\n    description: "CI test flag.",\n    default: false,\n    risky: false,\n  },\n  batch_recheck: {'
      );
      const docs = readFileSync(
        path.resolve(process.cwd(), "docs/FEATURE_FLAGS.md"),
        "utf8"
      ).replace(
        "| `dlq_retry` | `true` |",
        "| `stale_ci_flag` | `false` | — | Stale test row | `src/lib/test.ts` |\n| `dlq_retry` |"
      );

      writeFileSync(path.join(sourceDirectory, "feature-flags.ts"), source);
      writeFileSync(path.join(docsDirectory, "FEATURE_FLAGS.md"), docs);

      const result = runCheck(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ci_test_flag");
      expect(result.stderr).toContain("stale_ci_flag");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

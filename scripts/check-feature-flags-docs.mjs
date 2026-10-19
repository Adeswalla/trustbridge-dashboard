import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root =
  process.argv[2] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function extractSourceFlagKeys(source) {
  const definition = source.match(
    /export const FEATURE_FLAGS\s*:[^{=]+=\s*\{([\s\S]*?)^\};/m
  );
  if (!definition) {
    throw new Error("Could not locate FEATURE_FLAGS in src/lib/feature-flags.ts");
  }

  return [...definition[1].matchAll(/^  ([a-z][a-z0-9_]*)\s*:\s*\{/gm)].map(
    ([, key]) => key
  );
}

export function extractDocumentedFlagKeys(markdown) {
  const heading = /^## The flags\s*$/m.exec(markdown);
  if (!heading) {
    throw new Error("Could not locate the 'The flags' table in docs/FEATURE_FLAGS.md");
  }
  const contentStart = heading.index + heading[0].length;
  const nextSection = markdown.indexOf("\n## ", contentStart);
  const section = markdown.slice(
    contentStart,
    nextSection < 0 ? undefined : nextSection
  );

  return [...section.matchAll(/^\| `([a-z][a-z0-9_]*)` \|/gm)].map(
    ([, key]) => key
  );
}

export function getFeatureFlagDocDrift(source, markdown) {
  const sourceKeys = new Set(extractSourceFlagKeys(source));
  const documentedKeys = new Set(extractDocumentedFlagKeys(markdown));

  return {
    undocumented: [...sourceKeys].filter((key) => !documentedKeys.has(key)).sort(),
    stale: [...documentedKeys].filter((key) => !sourceKeys.has(key)).sort(),
  };
}

function checkFeatureFlagDocs() {
  const source = readFileSync(
    path.join(root, "src/lib/feature-flags.ts"),
    "utf8"
  );
  const markdown = readFileSync(path.join(root, "docs/FEATURE_FLAGS.md"), "utf8");
  const drift = getFeatureFlagDocDrift(source, markdown);

  if (drift.undocumented.length || drift.stale.length) {
    console.error("Feature flag documentation is out of sync.");
    if (drift.undocumented.length) {
      console.error(`Missing from docs/FEATURE_FLAGS.md: ${drift.undocumented.join(", ")}`);
    }
    if (drift.stale.length) {
      console.error(`No longer defined in src/lib/feature-flags.ts: ${drift.stale.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Feature flag documentation matches src/lib/feature-flags.ts.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  checkFeatureFlagDocs();
}

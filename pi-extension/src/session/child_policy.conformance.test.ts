import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CHILD_DESCRIPTOR_ENV, resolveSessionExposure } from "./child_policy.js";
import { loadRemotePiPackageIdentity } from "./package_identity.js";

interface Vector {
  case: string;
  environment: Record<string, string>;
  descriptor?: Record<string, unknown>;
  expected: {
    classification: string;
    mode: string;
    source: string;
  };
}

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "conformance", "child-session");

function readVector(name: string): Vector {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) as Vector;
}

describe("child-session cross-repo conformance", () => {
  test("fixture hashes match the shared manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8")) as {
      algorithm: string;
      files: Record<string, string>;
    };
    expect(manifest.algorithm).toBe("sha256");
    for (const [name, expected] of Object.entries(manifest.files)) {
      const actual = createHash("sha256").update(fs.readFileSync(path.join(fixtureDir, name))).digest("hex");
      expect(actual, `${name} fixture hash drifted`).toBe(expected);
    }
  });

  test.each(["v1-current.json", "legacy-v0.json", "future-v2.json", "malformed-v1.json"])(
    "normalizes %s with the shared expected classification",
    (name) => {
      const vector = readVector(name);
      const env = {
        ...vector.environment,
        ...(vector.descriptor ? { [CHILD_DESCRIPTOR_ENV]: JSON.stringify(vector.descriptor) } : {}),
      };
      expect(resolveSessionExposure(env, { auto_start_relay: true }, loadRemotePiPackageIdentity())).toMatchObject(vector.expected);
    },
  );
});

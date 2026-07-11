import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RemotePiPackageIdentity {
  name: "remote-pi";
  version: string;
  manifestSha256: string;
}

export interface LoadRemotePiPackageIdentityOptions {
  packageJsonPath?: string;
  readFile?: (filePath: string) => string;
}

/** Load the exact package manifest that owns the currently executing extension. */
export function loadRemotePiPackageIdentity(
  options: LoadRemotePiPackageIdentityOptions = {},
): RemotePiPackageIdentity {
  const packageJsonPath = options.packageJsonPath
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const raw = (options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8")))(packageJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse loaded remote-pi manifest '${packageJsonPath}': ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Loaded remote-pi manifest '${packageJsonPath}' must be an object.`);
  }
  const pkg = parsed as Record<string, unknown>;
  if (pkg["name"] !== "remote-pi" || typeof pkg["version"] !== "string" || pkg["version"].trim().length === 0) {
    throw new Error(`Package manifest '${packageJsonPath}' is not a versioned remote-pi package.`);
  }
  return {
    name: "remote-pi",
    version: pkg["version"].trim(),
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

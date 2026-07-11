import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { loadRemotePiPackageIdentity } from "./package_identity.js";

describe("loaded remote-pi package identity", () => {
  test("hashes the exact owning package manifest", () => {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const raw = fs.readFileSync(packageUrl, "utf8");
    expect(loadRemotePiPackageIdentity()).toEqual({
      name: "remote-pi",
      version: "0.5.5",
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    });
  });
});

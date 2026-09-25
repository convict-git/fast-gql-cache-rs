import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

test("a base build that writes to stdout is still measured", (t) => {
  // Older builds logged from the WASM on every construction; the probe's
  // results must not share a channel with whatever the cache prints.
  const dir = mkdtempSync(join(tmpdir(), "bench-noisy-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "base");
  cpSync(join(REPO, "dist"), join(base, "dist"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(base, "node_modules"));
  symlinkSync(join(REPO, "pkg"), join(base, "pkg"));
  const file = join(base, "dist/InMemoryCacheRs.js");
  const source = readFileSync(file, "utf8");
  assert.ok(source.includes("    init() {"));
  writeFileSync(
    file,
    source.replace(
      "    init() {",
      '    init() {\n        console.log("noisy");'
    )
  );

  const out = join(dir, "result.json");
  const child = spawnSync(
    process.execPath,
    [
      join(REPO, "scripts/bench/run.mjs"),
      "--out",
      out,
      "--base-root",
      base,
      "--sections=10",
      "--runs=1",
      "--quick",
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  const { samples } = JSON.parse(readFileSync(out, "utf8"));
  const [first] = Object.values(samples);
  assert.deepEqual(Object.keys(first).sort(), [
    "apollo@base",
    "apollo@head",
    "rs@base",
    "rs@head",
  ]);
});

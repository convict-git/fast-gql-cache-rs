/**
 * Checks that the npm tarball is self-contained: every relative module a packed
 * JavaScript file imports, and every asset it loads with
 * `new URL("…", import.meta.url)`, is packed too.
 *
 *   npm run build && node scripts/check-pack.mjs
 *
 * It reads the file list from `npm pack --dry-run --json`, the list npm would
 * publish, so it catches what the `files` field alone does not show. wasm-pack,
 * for example, writes a `.gitignore` of `*` into `pkg/`, which silently dropped
 * every `pkg/` file from the tarball while `dist/` still imported them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pack] = JSON.parse(
  execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  })
);
const packed = new Set(pack.files.map((f) => normalize(f.path)));

const references = [
  // import … from "./x.js", export … from "../x.js", import("./x.js")
  /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
  // new URL("x.wasm", import.meta.url)
  /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

const missing = [];
let checked = 0;
for (const file of packed) {
  if (!file.endsWith(".js")) continue;
  const source = readFileSync(join(root, file), "utf8");
  for (const pattern of references) {
    for (const [, specifier] of source.matchAll(pattern)) {
      const target = normalize(join(dirname(file), specifier));
      checked++;
      if (!packed.has(target)) {
        const onDisk = existsSync(join(root, target)) ? "" : " (not built?)";
        missing.push(
          `${file} → ${specifier}: ${target} is not packed${onDisk}`
        );
      }
    }
  }
}

if (!packed.has(normalize("pkg/fast_gql_cache_rs_bg.wasm"))) {
  missing.push("pkg/fast_gql_cache_rs_bg.wasm is not packed");
}

if (missing.length) {
  console.error(
    `The tarball is not self-contained:\n  ${missing.join("\n  ")}`
  );
  process.exit(1);
}
console.log(
  `Tarball self-contained: ${packed.size} files, ${checked} relative references resolved.`
);

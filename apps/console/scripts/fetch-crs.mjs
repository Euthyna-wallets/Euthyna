#!/usr/bin/env node
// Puts the CRS prefix the browser provers need in public/crs/, so euthyna.io serves it and visitors
// never reach Aztec's CDN (src/lib/crs.ts). Runs before `vite build` and `vite`. Each file is checked
// against the hash pinned below: the same bytes on crs.aztec-cdn.foundation and crs.aztec-labs.com
// (checked 7 November 2026). A file already in place with the right hash is not fetched again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "crs");
const HOSTS = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"];
const FILES = [
  // 2^19 BN254 G1 points, compressed (32 bytes each): the first 16 MiB of g1_compressed.dat.
  { name: "g1_compressed.dat", bytes: 2 ** 19 * 32, sha256: "1d03ebeb73e1a6d426e44a2ccc88b04125ca185ab9d1679817380502a723fa80" },
  { name: "g2.dat", sha256: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f" },
  // 2^16 Grumpkin points (64 bytes each): what bb.js loads for every instance.
  { name: "grumpkin_g1_v2.dat", bytes: 2 ** 16 * 64, sha256: "64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd" },
];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function download(file) {
  let last;
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${file.name}`, file.bytes ? { headers: { Range: `bytes=0-${file.bytes - 1}` } } : {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const body = file.bytes ? data.subarray(0, file.bytes) : data;
      if (sha256(body) !== file.sha256) throw new Error(`sha256 mismatch from ${host}`);
      return body;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`${file.name}: ${last?.message ?? last}`);
}

mkdirSync(OUT, { recursive: true });
for (const file of FILES) {
  const path = join(OUT, file.name);
  if (existsSync(path) && sha256(readFileSync(path)) === file.sha256) continue;
  const body = await download(file);
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
  console.log(`crs: ${file.name} (${body.length} bytes) checked`);
}

/**
 * The proving key setup (CRS) comes from this site, not from Aztec's CDN: bb.js would otherwise
 * fetch it from crs.aztec-cdn.foundation on every first proof. The files in public/crs/ are a
 * prefix of Aztec's public CRS, fetched and checked against pinned hashes at build time
 * (scripts/fetch-crs.mjs).
 */
import type { Barretenberg } from "@aztec/bb.js";

const CRS_BASE = "/crs";
/** G1 points in the hosted file: enough for the email circuit (2^18 gates, bb.js's default 2^19). */
export const HOSTED_G1_POINTS = 2 ** 19;
/** bb.js reads compressed G1 points in chunks of 2^17 (4 MiB): a smaller CRS is rounded up. */
const G1_CHUNK = 2 ** 17;
/** Grumpkin points bb.js loads for every Barretenberg. */
const GRUMPKIN_POINTS = 2 ** 16;

async function bytes(path: string, length?: number): Promise<Uint8Array> {
  const response = await fetch(`${CRS_BASE}/${path}`, length ? { headers: { Range: `bytes=0-${length - 1}` } } : {});
  if (!response.ok) throw new Error(`Could not load the proving setup (${path}: HTTP ${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (length && data.length < length) throw new Error(`The proving setup is incomplete (${path})`);
  return length ? data.subarray(0, length) : data;
}

let g2: Promise<Uint8Array> | null = null;
let grumpkin: Promise<Uint8Array> | null = null;

/** A Barretenberg whose CRS holds at least `minimum` G1 points (twice the circuit's gates, rounded to a power of two), loaded from this site. */
export async function openProver(threads: number, minimum: number): Promise<Barretenberg> {
  const points = Math.ceil(minimum / G1_CHUNK) * G1_CHUNK;
  if (points > HOSTED_G1_POINTS) throw new Error(`This circuit needs ${points} CRS points; the site hosts ${HOSTED_G1_POINTS}`);
  const { Barretenberg } = await import("@aztec/bb.js");
  const [api, g1, g2Point, grumpkinPoints] = await Promise.all([
    Barretenberg.new({ threads, skipSrsInit: true }),
    bytes("g1_compressed.dat", points * 32),
    (g2 ??= bytes("g2.dat")),
    (grumpkin ??= bytes("grumpkin_g1_v2.dat", GRUMPKIN_POINTS * 64)),
  ]);
  try {
    await api.srsInitSrs({ pointsBuf: g1, numPoints: points, g2Point });
    await api.srsInitGrumpkinSrs({ pointsBuf: grumpkinPoints, numPoints: GRUMPKIN_POINTS });
    return api;
  } catch (error) {
    await api.destroy();
    throw error;
  }
}

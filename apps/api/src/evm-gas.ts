import {
  AbiDecodingZeroDataError,
  BaseError,
  createPublicClient,
  ExecutionRevertedError,
  fallback,
  http,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Public RPCs tried after the configured one. Each one answered
 * eth_estimateGas and eth_simulateV1 when added (2026-10-25).
 */
export const PUBLIC_RPCS: Record<number, string[]> = {
  84532: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org", "https://eth-sepolia.api.onfinality.io/public"],
};

export function rpcUrls(chainId: number, configured: Array<string | undefined> = []): string[] {
  return [...new Set([...configured.filter((url): url is string => Boolean(url)), ...(PUBLIC_RPCS[chainId] ?? [])])];
}

/** One client per chain that moves to the next RPC on network errors, never on a revert. */
export function chainClient(urls: string[]): PublicClient {
  if (urls.length === 0) throw new Error("no RPC configured");
  return createPublicClient({
    transport: fallback(urls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })), { retryCount: 0 }),
  }) as PublicClient;
}

export type GasCall = { to: Hex; value: bigint; data: Hex; gas?: bigint | undefined };

export class GasEstimateError extends Error {
  constructor(
    readonly code: "would_revert" | "rpc_unavailable",
    readonly index: number,
    message: string,
  ) {
    super(message);
  }
}

function reverted(error: unknown): boolean {
  return error instanceof BaseError && Boolean(error.walk((cause) => cause instanceof ExecutionRevertedError));
}

function reason(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** Headroom on eth_estimateGas, which already accounts for refunds and the 63/64 rule. */
const ESTIMATE_HEADROOM = (gas: bigint) => (gas * 13n) / 10n;
/**
 * A simulated call reports gas used after refunds (up to 1/5 back) and without
 * the 63/64 margin of nested calls: leave more room than for an estimate.
 */
const SIMULATED_HEADROOM = (gas: bigint) => (gas * 3n) / 2n + 30_000n;

/**
 * Gas limits for calls sent in this order from one wallet on one chain. The
 * first call is estimated; the later ones run in one simulation after the
 * earlier calls, so an approve-then-supply is estimated on the right state.
 * Never falls back to a guessed limit: a call that would revert, or a chain no
 * RPC answers for, is an error the members see before voting.
 */
export async function estimateCalls(client: PublicClient, from: Hex, calls: GasCall[]): Promise<bigint[]> {
  if (calls.length === 0) return [];
  const limits: bigint[] = [];
  const first = calls[0]!;
  try {
    limits.push(ESTIMATE_HEADROOM(await client.estimateGas({ account: from, to: first.to, value: first.value, data: first.data })));
  } catch (error) {
    if (reverted(error)) throw new GasEstimateError("would_revert", 0, reason(error));
    throw new GasEstimateError("rpc_unavailable", 0, reason(error));
  }
  if (calls.length > 1) {
    let simulated;
    try {
      [simulated] = await client.simulateBlocks({
        blocks: [{ calls: calls.map((call) => ({ account: from, to: call.to, value: call.value, data: call.data })) }],
        validation: false,
      });
    } catch (error) {
      throw new GasEstimateError("rpc_unavailable", 1, reason(error));
    }
    for (let index = 1; index < calls.length; index += 1) {
      const result = simulated?.calls[index];
      if (!result) throw new GasEstimateError("rpc_unavailable", index, "the simulation returned no result for this call");
      if (result.status !== "success") {
        // An empty revert decodes as "returned no data": say what happened instead.
        const detail = result.error && !(result.error instanceof AbiDecodingZeroDataError) ? `: ${reason(result.error)}` : " (no reason given)";
        throw new GasEstimateError("would_revert", index, `execution reverted after the earlier calls${detail}`);
      }
      limits.push(SIMULATED_HEADROOM(result.gasUsed));
    }
  }
  // A dApp's own gas figure is a floor, never a cap.
  return limits.map((limit, index) => {
    const asked = calls[index]?.gas;
    return asked !== undefined && asked > limit ? asked : limit;
  });
}

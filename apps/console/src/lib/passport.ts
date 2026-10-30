/**
 * ZKPassport in the console: ask the phone app for a proof bound to one NEAR account,
 * and check a proof again on Ethereum Sepolia (ZKPassport's verifier contract), so a
 * member does not have to trust Euthyna's server about it.
 */
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

export const RECOVERY_SCOPE = "euthyna-recovery";
/** Mock IDs (issuer ZKR) are accepted on testnet only. */
export const PASSPORT_DEV_MODE = (import.meta.env.VITE_ZKPASSPORT_DEV_MODE ?? "1") === "1";

export type PassportEvidence = { proofs: unknown[]; query: Record<string, unknown>; result: Record<string, unknown> };

type Sdk = typeof import("@zkpassport/sdk");
let sdk: Promise<Sdk> | null = null;
const load = () => (sdk ??= import("@zkpassport/sdk"));

/** Shows `url` (QR code) until the app answers; resolves with the proofs for the API. */
export async function requestPassportProof(account: string, purpose: string, onUrl: (url: string) => void, onScanned?: () => void): Promise<PassportEvidence> {
  const { ZKPassport } = await load();
  const zk = new ZKPassport();
  const builder = await zk.request({ name: "Euthyna", purpose, scope: RECOVERY_SCOPE, devMode: PASSPORT_DEV_MODE, mode: "compressed-evm" });
  const { url, query, onRequestReceived, onSuccess, onError, onReject } = builder.bind("custom_data", `near:${account}`).done() as ReturnType<ReturnType<typeof builder.bind>["done"]> & { onReject?: (cb: () => void) => void };
  onUrl(url);
  return new Promise<PassportEvidence>((resolve, reject) => {
    onRequestReceived(() => onScanned?.());
    onError((error) => reject(new Error(error)));
    onReject?.(() => reject(new Error("The request was declined in the ZKPassport app.")));
    onSuccess(({ proofs, result }) => {
      resolve({ proofs, query: query as unknown as Record<string, unknown>, result: result as unknown as Record<string, unknown> });
    });
  });
}

/** Re-verify on Ethereum Sepolia: true and the identifier when ZKPassport's contract accepts the proof. */
export async function checkOnSepolia(evidence: PassportEvidence): Promise<{ ok: boolean; uniqueIdentifier: string; boundTo: string | null }> {
  const { ZKPassport } = await load();
  const zk = new ZKPassport(window.location.hostname);
  const proof = (evidence.proofs as Array<{ name?: string }>).find((item) => item.name?.startsWith("outer_evm"));
  if (!proof) throw new Error("This proof was not made for on-chain verification.");
  const parameters = zk.getSolidityVerifierParameters({ proof: proof as never, scope: RECOVERY_SCOPE, devMode: PASSPORT_DEV_MODE });
  const verifier = zk.getSolidityVerifierDetails();
  const client = createPublicClient({ chain: sepolia, transport: http(import.meta.env.VITE_ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const [ok, uniqueIdentifier] = await client.readContract({ address: verifier.address, abi: verifier.abi, functionName: verifier.functionName, args: [parameters] }) as [boolean, string];
  const boundTo = (evidence.result.bind as { custom_data?: string } | undefined)?.custom_data ?? null;
  return { ok, uniqueIdentifier, boundTo };
}

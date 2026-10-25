import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { useEffect, useState } from "react";

/**
 * The company wallet as a WalletConnect wallet: a dApp (Aave, Uniswap, a bridge…)
 * connects to it like to Rabby. Nothing is ever signed here: each transaction the
 * dApp asks for becomes a proposal the members vote on.
 */
const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

export const walletConnectEnabled = Boolean(PROJECT_ID);

let kitPromise: Promise<InstanceType<typeof WalletKit>> | null = null;

function kit() {
  if (!PROJECT_ID) throw new Error("WalletConnect is not configured (VITE_WALLETCONNECT_PROJECT_ID)");
  kitPromise ??= WalletKit.init({
    // Library types disagree under exactOptionalPropertyTypes; the instance is the documented one.
    core: new Core({ projectId: PROJECT_ID }) as unknown as WalletKitTypes.Options["core"],
    metadata: {
      name: "MandateOS company wallet",
      description: "Transactions are voted by the company's members before they are signed.",
      url: window.location.origin,
      icons: [],
    },
  });
  return kitPromise;
}

export type DappTransaction = {
  id: number;
  topic: string;
  app: { name: string; url: string };
  chainId: number;
  to: string;
  value: string;
  data: string;
  gas?: string;
};

export type DappSession = { topic: string; name: string; url: string; chains: number[] };

/** What a connected dApp may ask; signatures are refused, transactions become proposals. */
const METHODS = ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4", "eth_sign"];
const EVENTS = ["accountsChanged", "chainChanged"];

export function useWalletConnect(input: { address: string | null; chains: number[] }) {
  const [sessions, setSessions] = useState<DappSession[]>([]);
  const [proposal, setProposal] = useState<WalletKitTypes.SessionProposal | null>(null);
  const [requests, setRequests] = useState<DappTransaction[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSessions = async () => {
    const walletKit = await kit();
    setSessions(Object.values(walletKit.getActiveSessions()).map((session) => ({
      topic: session.topic,
      name: session.peer.metadata.name,
      url: session.peer.metadata.url,
      chains: (session.namespaces.eip155?.chains ?? []).map((chain) => Number(chain.split(":")[1])),
    })));
  };

  useEffect(() => {
    if (!walletConnectEnabled) return;
    let active = true;
    const onProposal = (event: WalletKitTypes.SessionProposal) => active && setProposal(event);
    const onRequest = async (event: WalletKitTypes.SessionRequest) => {
      const walletKit = await kit();
      const session = walletKit.getActiveSessions()[event.topic];
      const app = { name: session?.peer.metadata.name ?? "dApp", url: session?.peer.metadata.url ?? "" };
      const { method, params } = event.params.request;
      if (method !== "eth_sendTransaction") {
        // Off-chain signatures (permits, logins) are not covered by votes yet.
        await walletKit.respondSessionRequest({
          topic: event.topic,
          response: { id: event.id, jsonrpc: "2.0", error: { code: 4200, message: "MandateOS: the company wallet only sends transactions voted by its members; signatures are not supported." } },
        });
        if (active) setNotice(`${app.name} asked for a signature (${method}); refused: only transactions can be voted.`);
        return;
      }
      const [transaction] = params as Array<{ to: string; value?: string; data?: string; gas?: string }>;
      const chainId = Number(event.params.chainId.split(":")[1]);
      if (!active || !transaction) return;
      setRequests((current) => [...current, {
        id: event.id,
        topic: event.topic,
        app,
        chainId,
        to: transaction.to,
        value: BigInt(transaction.value ?? "0x0").toString(),
        data: transaction.data ?? "0x",
        ...(transaction.gas ? { gas: BigInt(transaction.gas).toString() } : {}),
      }]);
    };
    const onDelete = () => void refreshSessions();
    void kit().then((walletKit) => {
      walletKit.on("session_proposal", onProposal);
      walletKit.on("session_request", onRequest);
      walletKit.on("session_delete", onDelete);
      void refreshSessions();
    }).catch((cause: unknown) => setNotice(String(cause)));
    return () => {
      active = false;
      void kit().then((walletKit) => {
        walletKit.off("session_proposal", onProposal);
        walletKit.off("session_request", onRequest);
        walletKit.off("session_delete", onDelete);
      });
    };
  }, []);

  return {
    enabled: walletConnectEnabled,
    sessions,
    proposal,
    requests,
    notice,
    async pair(uri: string) {
      setNotice(null);
      await (await kit()).pair({ uri: uri.trim() });
    },
    async approve() {
      if (!proposal || !input.address) return;
      const walletKit = await kit();
      const namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces: {
          eip155: {
            chains: input.chains.map((chain) => `eip155:${chain}`),
            methods: METHODS,
            events: EVENTS,
            accounts: input.chains.map((chain) => `eip155:${chain}:${input.address}`),
          },
        },
      });
      await walletKit.approveSession({ id: proposal.id, namespaces });
      setProposal(null);
      await refreshSessions();
    },
    async reject() {
      if (!proposal) return;
      await (await kit()).rejectSession({ id: proposal.id, reason: getSdkError("USER_REJECTED") });
      setProposal(null);
    },
    /**
     * The dApp waits for a transaction hash it cannot get before the vote: answer
     * with a clear message so it stops waiting, and keep the proposal on our side.
     */
    async answer(request: DappTransaction, message: string) {
      await (await kit()).respondSessionRequest({
        topic: request.topic,
        response: { id: request.id, jsonrpc: "2.0", error: { code: 4001, message } },
      });
      setRequests((current) => current.filter((item) => item.id !== request.id));
    },
    async disconnect(topic: string) {
      await (await kit()).disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
      await refreshSessions();
    },
  };
}

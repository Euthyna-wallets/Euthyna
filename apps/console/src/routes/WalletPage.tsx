import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BASE_SEPOLIA, chainName, decodeVaultCalls, describeCall, describeVaultCall } from "@mandateos/sdk/roles";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseEther, parseUnits, type Hex } from "viem";

import { Card, PageState } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { useWalletConnect, type DappTransaction } from "../lib/walletconnect.js";
import { omni, type ProposalDraft, type Sentence } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";

export type Requested = { chainId: number; to: string; value: string; data: string; gas?: string };

/** Optimism-standard bridge on Ethereum Sepolia that deposits ETH to Base Sepolia (same address). */
const BASE_SEPOLIA_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const BRIDGE_ABI = parseAbi(["function depositETH(uint32 minGasLimit, bytes extraData)"]);

/**
 * The server prepares the proposal; this browser decodes it and refuses to sign
 * unless it carries exactly the requested calls (fees are the only addition).
 */
export function verifyTransactions(draft: ProposalDraft, requested: Requested[], daoAccountId: string, vaultAccountId: string): Sentence[] {
  if (draft.receiverId !== daoAccountId) throw new Error(`The proposal targets ${draft.receiverId}, not the company DAO. Nothing was signed.`);
  const calls = decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], vaultAccountId);
  const call = calls?.length === 1 ? calls[0] : null;
  if (!call || call.method !== "submit_transactions" || call.transactions.length !== requested.length) {
    throw new Error("The proposal prepared by the server does not match the requested transactions. Nothing was signed.");
  }
  call.transactions.forEach((transaction, index) => {
    const asked = requested[index]!;
    const same = transaction.chainId === asked.chainId
      && transaction.to.toLowerCase() === asked.to.toLowerCase()
      && transaction.value === asked.value
      && transaction.data.toLowerCase() === (asked.data || "0x").toLowerCase();
    if (!same) throw new Error(`Transaction ${index + 1} prepared by the server differs from the request. Nothing was signed.`);
  });
  return [describeVaultCall(call, { profile: BASE_SEPOLIA, fullAddresses: true })];
}

export function WalletPage() {
  const wallets = useWallets();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, refetchInterval: 15_000 });
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const address = status.data?.wallet?.address ?? null;
  const chains = (status.data?.chains ?? []).filter((chain) => chain.enabled).map((chain) => chain.chainId);
  const walletConnect = useWalletConnect({ address, chains });
  const [basket, setBasket] = useState<Requested[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ draft: ProposalDraft; summary: Sentence[]; requested: Requested[]; request?: DappTransaction } | null>(null);
  const treasury = status.data?.treasury;
  const me = wallets.nearAccountId;

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
      await queryClient.invalidateQueries({ queryKey: ["omni-status"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function prepare(requested: Requested[], title: string | undefined, request?: DappTransaction) {
    if (!treasury) return;
    const draft = await omni.transactionProposal({ ...(title ? { title } : {}), transactions: requested });
    const summary = verifyTransactions(draft, requested, treasury.daoAccountId, treasury.vaultAccountId);
    setPreview({ draft, summary, requested, ...(request ? { request } : {}) });
  }

  const describe = (item: Requested) => describeCall(getAddress(item.to), (item.data || "0x") as Hex, BigInt(item.value), { profile: BASE_SEPOLIA, labels: address ? { [address]: "company wallet" } : {} });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Company wallet</h1>
          <p className="muted">
            Agents act inside their roles. Anything else, members vote on the exact transaction: it is signed after the vote and the veto window.
          </p>
        </div>
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      <PageState loading={status.isLoading} error={status.error}>
        <Card title="Address">
          {address ? (
            <div className="stack">
              <div className="row wrap">
                <strong className="mono">{address}</strong>
                <button className="ghost" onClick={() => void navigator.clipboard.writeText(address)}>Copy</button>
              </div>
              <p className="small muted">The same address on every EVM chain. Base Sepolia balance: {status.data?.wallet?.eth} ETH{status.data?.wallet?.tokens.filter((token) => Number(token.amount) > 0).map((token) => ` · ${token.amount} ${token.symbol}`).join("")}</p>
              <div className="row wrap">
                {(status.data?.chains ?? []).map((chain) => chain.enabled ? (
                  <span key={chain.chainId} className="pill">{chain.name} ✓</span>
                ) : (
                  <button key={chain.chainId} className="ghost" disabled={!me || Boolean(busy)} onClick={() => void run(`chain-${chain.chainId}`, async () => {
                    const result = await signDaoProposal(me, await omni.walletProposal(chain.chainId));
                    return `Proposal #${result.proposalId} submitted: use the wallet on ${chain.name}.`;
                  })}>Use it on {chain.name}</button>
                ))}
              </div>
            </div>
          ) : <div className="state">The wallet is created by the first vote. <Link to="/onboarding">Continue setup</Link></div>}
        </Card>

        {address ? (
          <Card title="Connect an app">
            {!walletConnect.enabled ? <div className="state">WalletConnect is not configured on this console.</div> : (
              <div className="stack">
                <p className="small muted">
                  In the app (Aave, Uniswap, a bridge…), choose WalletConnect, copy the connection link and paste it here.
                  Each transaction the app asks for becomes a proposal; signatures are refused.
                </p>
                <ConnectForm busy={Boolean(busy)} onPair={(uri) => run("pair", async () => { await walletConnect.pair(uri); })} />
                {walletConnect.notice ? <div className="notice">{walletConnect.notice}</div> : null}
                {walletConnect.proposal ? (
                  <div className="decision">
                    <header><div><span className="eyebrow">Connection request</span><h3>{walletConnect.proposal.params.proposer.metadata.name}</h3></div></header>
                    <p className="small mono">{walletConnect.proposal.params.proposer.metadata.url}</p>
                    <footer className="row">
                      <div className="spacer" />
                      <button className="ghost" onClick={() => void run("reject", walletConnect.reject)}>Reject</button>
                      <button className="primary" onClick={() => void run("approve", async () => { await walletConnect.approve(); return "Connected. Transactions the app asks for will appear below."; })}>Connect the company wallet</button>
                    </footer>
                  </div>
                ) : null}
                {walletConnect.sessions.map((session) => (
                  <div key={session.topic} className="row wrap">
                    <span>Connected to <strong>{session.name}</strong> <span className="small muted mono">{session.url}</span> · {session.chains.map(chainName).join(", ")}</span>
                    <div className="spacer" />
                    <button className="ghost" onClick={() => void run("disconnect", () => walletConnect.disconnect(session.topic))}>Disconnect</button>
                  </div>
                ))}
                {walletConnect.requests.map((request) => (
                  <div key={request.id} className="decision">
                    <header><div><span className="eyebrow">{request.app.name} asks</span><h3>{describe(request)} on {chainName(request.chainId)}</h3></div></header>
                    <footer className="row">
                      <div className="spacer" />
                      <button className="ghost" onClick={() => void run("decline", () => walletConnect.answer(request, "MandateOS: declined by the member."))}>Decline</button>
                      <button className="primary" disabled={!me || Boolean(busy)} onClick={() => void run("prepare", () => prepare([request], `${request.app.name}: ${describe(request)}`, request))}>Propose to the members</button>
                    </footer>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : null}

        {address ? (
          <Card title="New transaction">
            <TransactionBuilder
              chains={status.data?.chains ?? []}
              onAdd={(item) => setBasket((current) => [...current, item])}
              wallet={address}
            />
            {basket.length ? (
              <div className="stack">
                <ol className="small">
                  {basket.map((item, index) => <li key={index}>{describe(item)} on {chainName(item.chainId)} <button className="ghost compact" onClick={() => setBasket((current) => current.filter((_, position) => position !== index))}>Remove</button></li>)}
                </ol>
                <div className="row">
                  <span className="small muted">They run in this order, one after the other.</span>
                  <div className="spacer" />
                  <button className="primary" disabled={!me || Boolean(busy)} onClick={() => void run("prepare", () => prepare(basket, undefined))}>Preview the proposal</button>
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}

        {preview ? (
          <div className="decision">
            <header><div><span className="eyebrow">Members will vote on</span><h3>{preview.draft.title}</h3></div></header>
            <SentenceList items={preview.summary} />
            <p className="small muted verified">✓ Checked in your browser: the proposal carries exactly these calls; MandateOS only added the network fees.</p>
            <footer className="row wrap">
              <span className="small muted">Submitting locks a 0.1 NEAR proposal bond, returned when the proposal passes.</span>
              <div className="spacer" />
              <button className="ghost" onClick={() => setPreview(null)}>Cancel</button>
              <button className="primary" disabled={!me || Boolean(busy)} onClick={() => void run("submit", async () => {
                const result = await signDaoProposal(me, preview.draft);
                if (preview.request) {
                  await walletConnect.answer(preview.request, `MandateOS: submitted to the company's vote as proposal #${result.proposalId}. It runs after the vote and the veto window.`);
                } else {
                  setBasket([]);
                }
                setPreview(null);
                return `Proposal #${result.proposalId} submitted. Members vote in Decisions.`;
              })}>Submit to the members' vote</button>
            </footer>
          </div>
        ) : null}

        <Card title="Voted transactions">
          {(governance.data?.transactions ?? []).length === 0 ? <div className="state">None yet.</div> : (
            <table>
              <tbody>
                {(governance.data?.transactions ?? []).map((item) => (
                  <tr key={item.opId}>
                    <td className="small">{item.details[0]}</td>
                    <td className="small">{item.state === "Scheduled" ? `veto window until ${new Date(item.executesAt ?? "").toLocaleTimeString()}` : item.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </PageState>
    </div>
  );
}

function ConnectForm(props: { busy: boolean; onPair: (uri: string) => void }) {
  const [uri, setUri] = useState("");
  return (
    <form className="row" onSubmit={(event) => { event.preventDefault(); props.onPair(uri); setUri(""); }}>
      <input placeholder="wc:…" value={uri} onChange={(event) => setUri(event.target.value)} />
      <button className="secondary" type="submit" disabled={props.busy || !uri.startsWith("wc:")}>Connect</button>
    </form>
  );
}

type Template = "eth" | "token" | "bridge" | "custom";

function TransactionBuilder(props: { chains: Array<{ chainId: number; name: string; enabled: boolean }>; wallet: string; onAdd: (item: Requested) => void }) {
  const [template, setTemplate] = useState<Template>("token");
  const [chainId, setChainId] = useState(BASE_SEPOLIA.chainId);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<string>(BASE_SEPOLIA.tokens[0]!.address);
  const [data, setData] = useState("0x");
  const [error, setError] = useState<string | null>(null);
  const enabled = props.chains.filter((chain) => chain.enabled);

  function build(): Requested {
    if (template === "eth") return { chainId, to: getAddress(to), value: parseEther(amount).toString(), data: "0x" };
    if (template === "token") {
      const decimals = BASE_SEPOLIA.tokens.find((item) => item.address === token)?.decimals ?? 18;
      return { chainId: BASE_SEPOLIA.chainId, to: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to), parseUnits(amount, decimals)] }) };
    }
    if (template === "bridge") {
      return { chainId: 11155111, to: BASE_SEPOLIA_BRIDGE, value: parseEther(amount).toString(), data: encodeFunctionData({ abi: BRIDGE_ABI, functionName: "depositETH", args: [200_000, "0x"] }) };
    }
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error("Data must be hex bytes");
    return { chainId, to: getAddress(to), value: amount ? parseEther(amount).toString() : "0", data };
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <label>Type
          <select value={template} onChange={(event) => setTemplate(event.target.value as Template)}>
            <option value="token">Send a token (Base Sepolia)</option>
            <option value="eth">Send ETH</option>
            <option value="bridge">Bridge ETH: Ethereum Sepolia → Base Sepolia</option>
            <option value="custom">Custom contract call</option>
          </select>
        </label>
        {template === "eth" || template === "custom" ? (
          <label>Chain
            <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))}>
              {enabled.map((chain) => <option key={chain.chainId} value={chain.chainId}>{chain.name}</option>)}
            </select>
          </label>
        ) : null}
        {template === "token" ? (
          <label>Token
            <select value={token} onChange={(event) => setToken(event.target.value)}>
              {BASE_SEPOLIA.tokens.map((item) => <option key={item.address} value={item.address}>{item.symbol}</option>)}
            </select>
          </label>
        ) : null}
        {template !== "bridge" ? <label>{template === "custom" ? "Contract" : "Recipient"}<input placeholder="0x…" value={to} onChange={(event) => setTo(event.target.value.trim())} /></label> : null}
        <label>{template === "token" ? "Amount" : "ETH"}<input inputMode="decimal" placeholder={template === "custom" ? "0" : ""} value={amount} onChange={(event) => setAmount(event.target.value.trim())} /></label>
        {template === "custom" ? <label>Data<input className="mono" placeholder="0x…" value={data} onChange={(event) => setData(event.target.value.trim())} /></label> : null}
      </div>
      {template === "bridge" ? (
        <p className="small muted">
          Deposits ETH held by the company wallet on Ethereum Sepolia into the Base bridge ({BASE_SEPOLIA_BRIDGE}). It arrives at the same address on Base Sepolia a few minutes later.
          {!props.chains.some((chain) => chain.chainId === 11155111 && chain.enabled) ? " The wallet must first be enabled on Ethereum Sepolia (button above)." : ""}
        </p>
      ) : null}
      {error ? <div className="alert error">{error}</div> : null}
      <div className="row">
        <button onClick={() => {
          setError(null);
          try {
            props.onAdd(build());
            setAmount("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}>Add to the proposal</button>
      </div>
    </div>
  );
}

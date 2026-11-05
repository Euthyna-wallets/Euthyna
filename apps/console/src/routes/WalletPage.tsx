import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BASE_SEPOLIA, chainName, decodeVaultCalls, describeCall, describeVaultCall } from "@mandateos/sdk/roles";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, parseEther, parseUnits, type Hex } from "viem";

import { PageState } from "../components/ui.js";
import { chainLabel, ColumnGauge, Kicker, NightPanel, PageTitle, Seal, SectionHead, Slab } from "../components/design.js";
import { formatUsd } from "../lib/money.js";
import { useWallets } from "../lib/wallet-context.js";
import { useWalletConnect, type DappTransaction } from "../lib/walletconnect.js";
import { formatAmount, omni, type ProposalDraft, type Sentence } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";
import { HoldingsCard } from "./HoldingsCard.js";
import { SealedOrdersCard } from "./SealedOrdersCard.js";

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

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/** The proposal's calls, one carved line each, on the night panel. */
function PreviewLines({ items }: { items: Sentence[] }) {
  const rows = items.flatMap((item, index) => [
    ...(item.title ? [{ key: `t-${index}`, text: item.title, title: true }] : []),
    ...item.details.map((detail, detailIndex) => ({ key: `d-${index}-${detailIndex}`, text: detail.replace(/^ {2}· /, ""), title: false })),
  ]);
  return (
    <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--night-line)" }}>
      {rows.map((row, index) => (
        <div
          key={row.key}
          style={{
            display: "grid",
            gridTemplateColumns: "34px minmax(0, 1fr)",
            padding: "10px 0",
            borderBottom: "1px solid var(--night-line)",
            fontSize: 14,
            color: row.title ? "#fff" : "var(--night-soft)",
            fontWeight: row.title ? 700 : 400,
          }}
        >
          <b style={{ font: "700 13px var(--font-brand)", color: "var(--gold)" }}>{ROMAN[index + 1] ?? String(index + 1)}</b>
          <span>{row.text}</span>
        </div>
      ))}
    </div>
  );
}

const addrLabel = { font: "700 11px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-2)" } as const;
const addrValue = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 } as const;

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
  const holdings = useQuery({ queryKey: ["omni-holdings"], queryFn: omni.holdings, enabled: Boolean(address), refetchInterval: 30_000 });
  const byChain = (holdings.data?.chains ?? [])
    .map((chain) => ({ chain: chain.chain, usd: chain.assets.reduce((sum, asset) => sum + (asset.usd ?? 0), 0) }))
    .sort((a, b) => b.usd - a.usd);
  const maxChain = Math.max(1, ...byChain.map((item) => item.usd));

  return (
    <div className="page" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "600 12px var(--font-ui)", color: "var(--ink-3)" }}>The treasury</span>
          <PageTitle>Treasury</PageTitle>
          <span style={{ fontSize: 14, color: "var(--ink-2)", maxWidth: 720 }}>
            Agents act inside their roles. Anything else, members vote on the exact transaction: it is signed after the vote and the veto window.
          </span>
        </div>
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      <PageState loading={status.isLoading} error={status.error}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, .95fr)", gap: 20, alignItems: "stretch" }}>
            <section
              className="ori-panel"
              style={{ padding: "20px 26px", display: "flex", flexDirection: "column", gap: 14, boxShadow: "18px 22px 40px rgba(13,23,48,.3), inset 0 1px 0 rgba(255,230,190,.5)" }}
            >
              <SectionHead
                left={<Kicker color="rgba(32,10,3,.75)">Held by the company</Kicker>}
                right={<span style={{ fontSize: 12, color: "rgba(32,10,3,.75)" }}>testnet values</span>}
              />
              {status.data?.wallet ? (
                <>
                  <b className="mono" style={{ font: "700 48px/1 var(--font-mono)", color: "rgba(32,10,3,.85)", textShadow: "0 1px 0 rgba(255,222,170,.55), 0 -1px 0 rgba(30,6,0,.4)" }}>
                    {holdings.isLoading ? "…" : holdings.data ? formatUsd(holdings.data.totalUsd) : `${formatAmount(status.data.wallet.eth, "ETH")}`}
                  </b>
                  <span style={{ fontSize: 13, color: "rgba(32,10,3,.75)", maxWidth: 360 }}>
                    {byChain.length ? `On ${byChain.map((item) => item.chain).join(", ")}.` : "Base Sepolia."} Every wallet is derived from the vault and has no private key.
                    {holdings.data?.chains.some((chain) => chain.assets.some((asset) => asset.usd === null)) ? " Test tokens are not counted." : ""}
                  </span>
                  {byChain.length ? (
                    <div style={{ display: "flex", gap: 18, alignItems: "flex-end", paddingTop: 6, flexWrap: "wrap" }} role="img" aria-label={`Holdings by chain: ${byChain.map((item) => `${item.chain} ${formatUsd(item.usd)}`).join(", ")}`}>
                      {byChain.map((item) => (
                        <ColumnGauge key={item.chain} value={item.usd} max={maxChain} label={chainLabel(item.chain)} amount={formatUsd(item.usd)} height={Math.max(24, Math.round((item.usd / maxChain) * 120))} />
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <span style={{ fontSize: 14, color: "#200A03" }}>
                  The wallet is created by the first vote. <Link to="/onboarding">Continue setup</Link>
                </span>
              )}
            </section>

            <Slab style={{ padding: "18px 22px 10px", display: "flex", flexDirection: "column" }}>
              <Kicker>Addresses · no private key</Kicker>
              <span style={{ fontSize: 13, color: "var(--ink-2)", margin: "6px 0 8px" }}>
                Each address is derived from the vault. It signs only what a role allows or what the members voted.
              </span>
              {address ? (
                <>
                  {(status.data?.chains ?? []).map((chain) => (
                    <div
                      key={chain.chainId}
                      style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13 }}
                    >
                      <b style={addrLabel}>{chain.name}</b>
                      {chain.enabled ? <span className="mono" style={addrValue}>{address}</span> : <span style={{ color: "var(--ink-3)", fontSize: 12.5 }}>Not requested yet</span>}
                      {chain.enabled ? (
                        <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => void navigator.clipboard.writeText(address)}>Copy</button>
                      ) : (
                        <button className="btn-line" style={{ padding: "8px 12px", fontSize: 11 }} disabled={!me || Boolean(busy)} onClick={() => void run(`chain-${chain.chainId}`, async () => {
                          const result = await signDaoProposal(me, await omni.walletProposal(chain.chainId));
                          return `Proposal #${result.proposalId} submitted: use the wallet on ${chain.name}.`;
                        })}>Use it on {chain.name}</button>
                      )}
                    </div>
                  ))}
                  {treasury ? (
                    <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13 }}>
                      <b style={addrLabel}>NEAR</b>
                      <span className="mono" style={addrValue}>{treasury.vaultAccountId}</span>
                      <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => void navigator.clipboard.writeText(treasury.vaultAccountId)}>Copy</button>
                    </div>
                  ) : null}
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0 6px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                    <Seal word="INTACT" size={36} />
                    <span style={{ fontSize: 12.5, color: "var(--aegean-ink)" }}>Every transaction that left these wallets was signed through the vault.</span>
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ padding: "10px 0" }}>The wallet is created by the first vote.</div>
              )}
            </Slab>
          </div>

          {address ? <HoldingsCard /> : null}

          {address ? <SealedOrdersCard /> : null}

          {address && status.data?.solana ? (
            <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 10 }}>
              <Kicker>Solana</Kicker>
              {!status.data.solana.supported ? (
                <div className="empty-state">This vault predates Solana support: members can vote an upgrade to the latest published version first.</div>
              ) : status.data.solana.address ? (
                <>
                  <div className="row wrap" style={{ justifyContent: "space-between" }}>
                    <strong className="mono" style={{ fontSize: 13 }}>{status.data.solana.address}</strong>
                    <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => void navigator.clipboard.writeText(status.data!.solana!.address!)}>Copy</button>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
                    {status.data.solana.network} balance: {status.data.solana.sol ?? "?"} SOL. An ed25519 key derived by NEAR MPC: nobody holds it,
                    agents send only what their role allows.
                  </p>
                </>
              ) : (
                <div className="row wrap" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Give the company a Solana wallet, governed by the same members and roles.</span>
                  <button className="btn-ori" style={{ padding: "11px 16px" }} disabled={!me || Boolean(busy)} onClick={() => void run("solana", async () => {
                    const result = await signDaoProposal(me, await omni.solanaWalletProposal());
                    return `Proposal #${result.proposalId} submitted: open the wallet on Solana.`;
                  })}>Open the Solana wallet</button>
                </div>
              )}
            </Slab>
          ) : null}

          <div className="g2" style={{ display: "grid", gridTemplateColumns: preview ? "minmax(0, .9fr) minmax(0, 1.1fr)" : "minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
              {/* Without a WalletConnect project id the block has nothing to offer a member: hide it. */}
              {address && walletConnect.enabled ? (
                <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <Kicker>Connect an app</Kicker>
                  {!walletConnect.enabled ? <div className="empty-state">WalletConnect is not configured on this console.</div> : (
                    <>
                      <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                        In the app (Aave, Uniswap, a bridge…), choose WalletConnect, copy the connection link and paste it here.
                        Each transaction the app asks for becomes a proposal; signatures are refused.
                      </span>
                      <ConnectForm busy={Boolean(busy)} onPair={(uri) => run("pair", async () => { await walletConnect.pair(uri); })} />
                      {walletConnect.notice ? (
                        <div style={{ border: "1px solid rgba(13,23,48,.14)", background: "rgba(255,255,255,.6)", padding: "10px 14px", fontSize: 12.5, color: "var(--ink-2)" }}>
                          {walletConnect.notice}
                        </div>
                      ) : null}
                      {walletConnect.proposal ? (
                        <div style={{ border: "1px solid rgba(13,23,48,.14)", background: "rgba(255,255,255,.6)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                          <Kicker color="var(--aegean-ink)">Connection request</Kicker>
                          <b style={{ fontSize: 15 }}>{walletConnect.proposal.params.proposer.metadata.name}</b>
                          <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{walletConnect.proposal.params.proposer.metadata.url}</span>
                          <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                            <button className="btn-line" onClick={() => void run("reject", walletConnect.reject)}>Reject</button>
                            <button className="btn-ori" onClick={() => void run("approve", async () => { await walletConnect.approve(); return "Connected. Transactions the app asks for will appear below."; })}>Connect the company wallet</button>
                          </div>
                        </div>
                      ) : null}
                      {walletConnect.sessions.map((session) => (
                        <div key={session.topic} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13, flexWrap: "wrap" }}>
                          <span>Connected to <strong>{session.name}</strong> <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{session.url}</span> · {session.chains.map(chainName).join(", ")}</span>
                          <div className="spacer" />
                          <button className="btn-line" style={{ padding: "6px 12px", fontSize: 10.5 }} onClick={() => void run("disconnect", () => walletConnect.disconnect(session.topic))}>Disconnect</button>
                        </div>
                      ))}
                      {walletConnect.requests.map((request) => (
                        <div key={request.id} style={{ border: "1px solid rgba(13,23,48,.14)", background: "rgba(255,255,255,.6)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                          <Kicker color="var(--aegean-ink)">{request.app.name} asks</Kicker>
                          <b style={{ fontSize: 15 }}>{describe(request)} on {chainName(request.chainId)}</b>
                          <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                            <button className="btn-line" style={{ padding: "8px 12px", fontSize: 10.5 }} onClick={() => void run("decline", () => walletConnect.answer(request, "Euthyna: declined by the member."))}>Decline</button>
                            <button className="btn-ori" style={{ padding: "9px 12px", fontSize: 10.5 }} disabled={!me || Boolean(busy)} onClick={() => void run("prepare", () => prepare([request], `${request.app.name}: ${describe(request)}`, request))}>Propose to the members</button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </Slab>
              ) : null}

              {address ? (
                <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <Kicker>New transaction</Kicker>
                  <TransactionBuilder
                    chains={status.data?.chains ?? []}
                    onAdd={(item) => setBasket((current) => [...current, item])}
                    wallet={address}
                  />
                  {basket.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid rgba(13,23,48,.12)" }}>
                        {basket.map((item, index) => (
                          <div key={index} className="row-rule" style={{ gridTemplateColumns: "26px minmax(0, 1fr)", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(13,23,48,.1)" }}>
                            <b>{ROMAN[index + 1] ?? String(index + 1)}</b>
                            <span style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", minWidth: 0 }}>
                              <span style={{ minWidth: 0 }}>{describe(item)} on {chainName(item.chainId)}</span>
                              <button className="btn-line" style={{ padding: "4px 10px", fontSize: 10 }} onClick={() => setBasket((current) => current.filter((_, position) => position !== index))}>Remove</button>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>They run in this order, one after the other.</span>
                        <div className="spacer" />
                        <button className="btn-ori" disabled={!me || Boolean(busy)} onClick={() => void run("prepare", () => prepare(basket, undefined))}>Preview the proposal</button>
                      </div>
                    </div>
                  ) : null}
                </Slab>
              ) : null}

              <Slab style={{ padding: "16px 22px 8px", display: "flex", flexDirection: "column" }}>
                <Kicker style={{ marginBottom: 6 }}>Voted transactions</Kicker>
                {(governance.data?.transactions ?? []).length === 0 ? <div className="empty-state">None yet.</div> : (
                  (governance.data?.transactions ?? []).map((item) => (
                    <div key={item.opId} style={{ display: "grid", gridTemplateColumns: "36px minmax(0, 1fr)", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13 }}>
                      <Seal word={item.state === "Scheduled" ? "HELD" : item.state.toUpperCase()} size={32} />
                      <div style={{ minWidth: 0 }}>
                        <b style={{ display: "block" }}>{item.details[0]}</b>
                        <small style={{ color: "var(--ink-3)" }}>
                          {item.state === "Scheduled" ? `veto window until ${new Date(item.executesAt ?? "").toLocaleTimeString()}` : item.state}
                        </small>
                      </div>
                    </div>
                  ))
                )}
              </Slab>
            </div>

            <div style={{ minWidth: 0 }}>
              {preview ? (
                <NightPanel style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
                  <Kicker color="var(--gold)">Members will vote on</Kicker>
                  <h3 style={{ margin: 0, font: "800 22px/1.25 var(--font-brand)", letterSpacing: ".04em", color: "#fff" }}>{preview.draft.title}</h3>
                  <PreviewLines items={preview.summary} />
                  <span style={{ fontSize: 12.5, color: "var(--aegean-link)" }}>
                    ✓ Checked in your browser: the proposal carries exactly these calls; Euthyna only added the network fees.
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--night-text)" }}>Submitting locks a 0.1 NEAR proposal bond, returned when the proposal passes.</span>
                  <div className="row wrap" style={{ justifyContent: "flex-end" }}>
                    <button className="btn-line on-dark" onClick={() => setPreview(null)}>Cancel</button>
                    <button className="btn-ori" disabled={!me || Boolean(busy)} onClick={() => void run("submit", async () => {
                      const result = await signDaoProposal(me, preview.draft);
                      if (preview.request) {
                        await walletConnect.answer(preview.request, `Euthyna: submitted to the company's vote as proposal #${result.proposalId}. It runs after the vote and the veto window.`);
                      } else {
                        setBasket([]);
                      }
                      setPreview(null);
                      return `Proposal #${result.proposalId} submitted. Members vote in Decisions.`;
                    })}>Submit to the members' vote</button>
                  </div>
                </NightPanel>
              ) : null}
            </div>
          </div>
        </div>
      </PageState>
    </div>
  );
}

function ConnectForm(props: { busy: boolean; onPair: (uri: string) => void }) {
  const [uri, setUri] = useState("");
  return (
    <form style={{ display: "flex", gap: 8, flexWrap: "wrap" }} onSubmit={(event) => { event.preventDefault(); props.onPair(uri); setUri(""); }}>
      <input
        className="mono"
        placeholder="wc:…"
        value={uri}
        onChange={(event) => setUri(event.target.value)}
        style={{ flex: 1, minWidth: 200, padding: "10px 12px", border: "1px solid rgba(13,23,48,.2)", background: "rgba(255,255,255,.7)", borderRadius: 2, fontSize: 12.5, color: "var(--ink)" }}
      />
      <button className="btn-line" style={{ padding: "9px 14px" }} type="submit" disabled={props.busy || !uri.startsWith("wc:")}>CONNECT</button>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <div className="field-app">
          <label>Type</label>
          <select value={template} onChange={(event) => setTemplate(event.target.value as Template)}>
            <option value="token">Send a token (Base Sepolia)</option>
            <option value="eth">Send ETH</option>
            <option value="bridge">Bridge ETH: Ethereum Sepolia → Base Sepolia</option>
            <option value="custom">Custom contract call</option>
          </select>
        </div>
        {template === "eth" || template === "custom" ? (
          <div className="field-app">
            <label>Chain</label>
            <select value={chainId} onChange={(event) => setChainId(Number(event.target.value))}>
              {enabled.map((chain) => <option key={chain.chainId} value={chain.chainId}>{chain.name}</option>)}
            </select>
          </div>
        ) : null}
        {template === "token" ? (
          <div className="field-app">
            <label>Token</label>
            <select value={token} onChange={(event) => setToken(event.target.value)}>
              {BASE_SEPOLIA.tokens.map((item) => <option key={item.address} value={item.address}>{item.symbol}</option>)}
            </select>
          </div>
        ) : null}
        {template !== "bridge" ? (
          <div className="field-app">
            <label>{template === "custom" ? "Contract" : "Recipient"}</label>
            <input placeholder="0x…" value={to} onChange={(event) => setTo(event.target.value.trim())} />
          </div>
        ) : null}
        <div className="field-app">
          <label>{template === "token" ? "Amount" : "ETH"}</label>
          <input inputMode="decimal" placeholder={template === "custom" ? "0" : ""} value={amount} onChange={(event) => setAmount(event.target.value.trim())} />
        </div>
        {template === "custom" ? (
          <div className="field-app">
            <label>Data</label>
            <input className="mono" placeholder="0x…" value={data} onChange={(event) => setData(event.target.value.trim())} />
          </div>
        ) : null}
      </div>
      {template === "bridge" ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
          Deposits ETH held by the company wallet on Ethereum Sepolia into the Base bridge ({BASE_SEPOLIA_BRIDGE}). It arrives at the same address on Base Sepolia a few minutes later.
          {!props.chains.some((chain) => chain.chainId === 11155111 && chain.enabled) ? " The wallet must first be enabled on Ethereum Sepolia (button above)." : ""}
        </p>
      ) : null}
      {error ? <div className="alert error">{error}</div> : null}
      <div className="row">
        <button className="btn-line" onClick={() => {
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

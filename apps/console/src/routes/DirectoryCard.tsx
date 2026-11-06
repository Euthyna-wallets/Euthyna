import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { REGISTRY_DESCRIPTION_MAX, REGISTRY_NAME_MAX, registryProposalKind } from "@euthyna/sdk/roles";

import { Card } from "../components/ui.js";
import { chainView } from "../lib/chain-view.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type DirectoryView, type ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

/**
 * Rebuild the listing vote from what the browser reads on chain: the vault must
 * be owned by this DAO and the shares contract must belong to it.
 */
async function verifyListing(draft: ProposalDraft, view: DirectoryView, name: string, description: string) {
  const owner = await chainView<string>(view.vaultAccountId, "owner_id");
  if (owner !== view.daoAccountId) throw new Error("The vault is not owned by this DAO: nothing was signed.");
  if (view.sharesAccountId) {
    const info = await chainView<{ dao_id: string }>(view.sharesAccountId, "info");
    if (info.dao_id !== view.daoAccountId) throw new Error("The shares contract belongs to another DAO: nothing was signed.");
  }
  const expected = registryProposalKind(view.registryId!, { vaultAccountId: view.vaultAccountId, sharesAccountId: view.sharesAccountId, name, description });
  if (draft.receiverId !== view.daoAccountId || JSON.stringify(draft.args.proposal.kind) !== JSON.stringify(expected)) {
    throw new Error("The server returned an unexpected proposal: nothing was signed.");
  }
}

/** The registry only lists DAOs created by its factory (`<name>.<factory>`): read which one, on chain. */
function acceptsDao(factoryId: string, daoAccountId: string): boolean {
  const label = daoAccountId.endsWith(`.${factoryId}`) ? daoAccountId.slice(0, -factoryId.length - 1) : "";
  return label.length > 0 && !label.includes(".");
}

export function DirectoryCard() {
  const wallets = useWallets();
  const query = useQuery({ queryKey: ["omni-directory"], queryFn: omni.directory });
  const registryId = query.data?.registryId;
  const factory = useQuery({
    queryKey: ["registry-factory", registryId],
    queryFn: () => chainView<string>(registryId!, "factory_id"),
    enabled: Boolean(registryId),
    staleTime: Infinity,
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const view = query.data;
  if (!view) return null;
  const me = wallets.nearAccountId;
  const listing = view.listing;

  async function propose() {
    if (!view || !me) return;
    setBusy(true);
    setMessage(null);
    try {
      const draft = await omni.registryProposal({ name, description });
      await verifyListing(draft, view, name.trim(), description);
      const result = await signDaoProposal(me, draft);
      setMessage(`Proposal #${result.proposalId} submitted. Members approve it in Decisions.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Public directory">
      {!view.registryId ? <p className="muted">No public directory is configured on this server.</p> : factory.data && !acceptsDao(factory.data, view.daoAccountId) ? (
        <p className="muted">
          This company cannot be listed: the directory <code>{view.registryId}</code> only accepts DAOs created by{" "}
          <code>{factory.data}</code>, and this one is <code>{view.daoAccountId}</code>. A listing vote would fail on chain.
        </p>
      ) : (
        <>
          <p className="muted">
            {listing
              ? <>Listed as <strong>{listing.name}</strong>. Anyone can read it from <code>{view.registryId}</code>.</>
              : "Not listed yet. A vote of the members lists the company; the registry checks on chain that the vault and shares belong to this DAO."}
          </p>
          <div className="stack">
            <label>Name<input maxLength={REGISTRY_NAME_MAX} value={name} placeholder={listing?.name ?? "Acme AI"} onChange={(event) => setName(event.target.value)} /></label>
            <label>One line on what the company does<input maxLength={REGISTRY_DESCRIPTION_MAX} value={description} placeholder={listing?.description ?? "Pentest and SOC on demand"} onChange={(event) => setDescription(event.target.value)} /></label>
            <button className="secondary" disabled={!me || busy || !name.trim() || !factory.data} onClick={() => void propose()}>{listing ? "Propose the update" : "Propose the listing"}</button>
          </div>
          {!me ? <p className="small muted">Connect your NEAR wallet to propose.</p> : null}
          {message ? <p className="small">{message}</p> : null}
        </>
      )}
    </Card>
  );
}

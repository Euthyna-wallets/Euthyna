import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useWallets } from "../lib/wallet-context.js";
import { omni } from "../omniroles-api.js";

/** Top bar reminder: proposals waiting for the connected member's vote. */
export function SigningInbox() {
  const wallets = useWallets();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, refetchInterval: 30_000 });
  const governance = useQuery({
    queryKey: ["omni-governance"],
    queryFn: omni.governance,
    enabled: Boolean(status.data?.treasury),
    refetchInterval: 15_000,
  });
  const me = wallets.nearAccountId;
  if (!governance.data || !me || !governance.data.dao.members.includes(me)) return <div />;
  const waiting = governance.data.proposals.filter((proposal) => proposal.status === "InProgress" && !(me in proposal.votes));
  if (waiting.length === 0) return <div className="small muted">No decision waiting for you</div>;
  return (
    <Link className="inbox" to="/governance">
      {waiting.length} decision{waiting.length > 1 ? "s" : ""} waiting for your vote →
    </Link>
  );
}

/**
 * Agents' NEAR gas paid by Euthyna (NEP-366 meta transactions). The agent signs a delegate action
 * with its function-call key, for one call to its vault or to the sealed-orders contract; the
 * relayer puts it in a transaction it signs, and pays the gas. The agent's account then only needs
 * its storage.
 *
 * Checked before anything is sent: the sender is this agent, the receiver its vault or the
 * sealed-orders contract, one function call, no deposit, at most 300 Tgas, a valid signature.
 * The key itself is checked by NEAR (a function-call key cannot reach another contract anyway).
 * Capped per agent per day and in total per day, in memory.
 */
import { decodeCheque, relayAction } from "./market/cheque.js";

export type RelayOutcome = {
  transaction_outcome: { id: string };
  receipts_outcome: Array<{ id: string; outcome: { executor_id: string; logs: string[]; receipt_ids: string[]; status: unknown } }>;
  status: unknown;
};

export interface AgentRelayNear {
  relayDelegate(senderId: string, action: unknown): Promise<RelayOutcome>;
}

export class AgentRelayError extends Error {
  constructor(readonly status: 400 | 403 | 429, readonly code: string, message: string) {
    super(message);
  }
}

const MAX_GAS = 300_000_000_000_000n;
const DAY_MS = 86_400_000;

export class AgentRelay {
  private readonly perAgent = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    private readonly near: AgentRelayNear,
    private readonly config: { sealedOrdersId: string | null; perAgentPerDay: number; totalPerDay: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  async relay(agent: { nearAccountId: string; vaultAccountId: string }, signedDelegate: string): Promise<{ receiverId: string; outcome: RelayOutcome }> {
    let cheque: ReturnType<typeof decodeCheque>;
    try {
      cheque = decodeCheque(signedDelegate);
    } catch {
      throw new AgentRelayError(400, "delegate_malformed", "signedDelegate is not a borsh SignedDelegate (base64)");
    }
    if (!cheque.signatureValid) throw new AgentRelayError(400, "delegate_signature", "the delegate's signature is not valid");
    if (cheque.senderId !== agent.nearAccountId) throw new AgentRelayError(403, "delegate_sender", "the delegate must come from this agent's account");
    const allowed = [agent.vaultAccountId, ...(this.config.sealedOrdersId ? [this.config.sealedOrdersId] : [])];
    if (!allowed.includes(cheque.receiverId)) throw new AgentRelayError(403, "delegate_receiver", `only calls to ${allowed.join(" or ")} are relayed`);
    if (cheque.actionCount !== 1 || !cheque.methodName || cheque.deposit !== 0n) {
      throw new AgentRelayError(403, "delegate_action", "one function call without deposit");
    }
    if (cheque.gas <= 0n || cheque.gas > MAX_GAS) throw new AgentRelayError(403, "delegate_gas", "at most 300 Tgas");

    const now = this.now();
    const recent = (this.perAgent.get(agent.nearAccountId) ?? []).filter((at) => now - at < DAY_MS);
    this.all = this.all.filter((at) => now - at < DAY_MS);
    if (recent.length >= this.config.perAgentPerDay || this.all.length >= this.config.totalPerDay) {
      throw new AgentRelayError(429, "relay_capped", "the daily quota of relayed calls is reached: the agent pays its gas itself");
    }
    this.perAgent.set(agent.nearAccountId, [...recent, now]);
    this.all.push(now);
    const outcome = await this.near.relayDelegate(agent.nearAccountId, relayAction(signedDelegate));
    return { receiverId: cheque.receiverId, outcome };
  }
}

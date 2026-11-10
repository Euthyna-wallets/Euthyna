/**
 * Keeps agents' NEAR accounts able to pay gas. An agent starts with 0.5 NEAR, and each call it
 * makes on the vault is paid from it. A call reserves its gas up front at a pessimistic price, so a
 * 300 Tgas call needs about 0.3 NEAR available even when it costs a hundredth of that. On
 * 10 November an agent at 0.288 NEAR after a judge walk could no longer place a sealed order.
 *
 * When an agent calls the API, its balance is read (at most once every few minutes) and, below
 * `belowYocto`, the relayer tops it up to `toYocto`. Capped per agent and per day, and in total per
 * day, so a compromised agent key cannot drain the relayer.
 */
export interface AgentGasConfig {
  belowYocto: bigint;
  toYocto: bigint;
  perAgentPerDay: number;
  totalPerDayYocto: bigint;
}

interface GasNear {
  getAccount(accountId: string): Promise<{ amount: string; locked?: string; storage_usage?: number }>;
  executeActions(receiverId: string, actions: Array<{ type: "Transfer"; depositYocto: string }>): Promise<string>;
}

/** What storage keeps locked on an account: 10^19 yoctoNEAR per byte. */
const STORAGE_YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
const CHECK_EVERY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class AgentGasKeeper {
  private readonly checkedAt = new Map<string, number>();
  private readonly topUps = new Map<string, number[]>();
  private spent: Array<{ at: number; yocto: bigint }> = [];
  private readonly busy = new Set<string>();

  constructor(
    private readonly near: GasNear,
    private readonly config: AgentGasConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
  ) {}

  /** Called on each request of an agent. Never throws; at most one read every few minutes per agent. */
  async check(agentAccountId: string): Promise<void> {
    const now = this.now();
    if (this.busy.has(agentAccountId) || now - (this.checkedAt.get(agentAccountId) ?? Number.NEGATIVE_INFINITY) < CHECK_EVERY_MS) return;
    this.busy.add(agentAccountId);
    this.checkedAt.set(agentAccountId, now);
    try {
      const account = await this.near.getAccount(agentAccountId);
      const available = BigInt(account.amount) - BigInt(account.storage_usage ?? 0) * STORAGE_YOCTO_PER_BYTE;
      if (available >= this.config.belowYocto) return;
      const amount = this.config.toYocto - (available > 0n ? available : 0n);
      const recent = (this.topUps.get(agentAccountId) ?? []).filter((at) => now - at < DAY_MS);
      this.spent = this.spent.filter((item) => now - item.at < DAY_MS);
      const spentToday = this.spent.reduce((sum, item) => sum + item.yocto, 0n);
      if (recent.length >= this.config.perAgentPerDay || spentToday + amount > this.config.totalPerDayYocto) {
        this.log({ event: "agent.gas_topup_capped", agentAccountId, availableYocto: available.toString(), topUpsToday: recent.length, spentTodayYocto: spentToday.toString() });
        return;
      }
      const transactionHash = await this.near.executeActions(agentAccountId, [{ type: "Transfer", depositYocto: amount.toString() }]);
      this.topUps.set(agentAccountId, [...recent, now]);
      this.spent.push({ at: now, yocto: amount });
      this.log({ event: "agent.gas_topped_up", agentAccountId, fromYocto: available.toString(), amountYocto: amount.toString(), transactionHash });
    } catch (error) {
      this.log({ event: "agent.gas_topup_failed", agentAccountId, message: String(error).slice(0, 160) });
    } finally {
      this.busy.delete(agentAccountId);
    }
  }
}

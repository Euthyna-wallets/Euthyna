import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  evmAddressBytes,
  MandateAgentClient,
  OnchainAgentClient,
  type PaymentRequest,
} from "@mandateos/sdk";
import { NEAR_TESTNET_TOKENS } from "@mandateos/sdk/roles";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const opId = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export class MandateMcpTools {
  constructor(private readonly client: MandateAgentClient | OnchainAgentClient) {}

  pay(input: {
    token: string;
    recipient: string;
    amount: string;
    reference: string;
    gasLimit?: string | undefined;
    maxFeePerGas?: string | undefined;
    maxPriorityFeePerGas?: string | undefined;
    invoiceText?: string | undefined;
    claimedRecipient?: string | undefined;
  }) {
    const intent: PaymentRequest = {
      token: evmAddressBytes(input.token as `0x${string}`),
      recipient: evmAddressBytes(input.recipient as `0x${string}`),
      amount: input.amount,
      reference: input.reference,
      ...(input.gasLimit ? { gas_limit: input.gasLimit } : {}),
      ...(input.maxFeePerGas ? { max_fee_per_gas: input.maxFeePerGas } : {}),
      ...(input.maxPriorityFeePerGas ? { max_priority_fee_per_gas: input.maxPriorityFeePerGas } : {}),
    };
    return this.client.pay(intent, {
      ...(input.invoiceText ? { text: input.invoiceText } : {}),
      ...(input.claimedRecipient ? { claimedRecipient: input.claimedRecipient as `0x${string}` } : {}),
    });
  }

  async check(input: {
    token?: string | undefined;
    recipient?: string | undefined;
    amount?: string | undefined;
    to?: string | undefined;
    data?: string | undefined;
    value?: string | undefined;
    allowanceAmount?: string | undefined;
    chainId?: number | undefined;
    reference: string;
  }) {
    if (input.token && input.recipient && input.amount) {
      return this.client.check({
        token: evmAddressBytes(input.token as `0x${string}`),
        recipient: evmAddressBytes(input.recipient as `0x${string}`),
        amount: input.amount,
        reference: input.reference,
      }, input.chainId ?? 84532);
    }
    if (!input.to) throw new Error("give either token + recipient + amount (a transfer) or to (+ data, value) for any other call");
    return this.client.check({
      chainId: input.chainId ?? 84532,
      to: input.to as `0x${string}`,
      ...(input.data ? { data: input.data as `0x${string}` } : {}),
      ...(input.value ? { value: input.value } : {}),
      ...(input.allowanceAmount ? { allowanceAmount: input.allowanceAmount } : {}),
      reference: input.reference,
    });
  }

  call(input: { chainId: number; to: string; data: string; value: string; allowanceAmount: string; reference: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }) {
    return this.client.call({ chain_id:input.chainId, target:evmAddressBytes(input.to as `0x${string}`), calldata:Array.from(Buffer.from(input.data.slice(2), "hex")), value:input.value, allowance_amount:input.allowanceAmount, reference:input.reference, gas_limit:input.gasLimit, max_fee_per_gas:input.maxFeePerGas, max_priority_fee_per_gas:input.maxPriorityFeePerGas });
  }

  mandate() {
    return this.client.mandate();
  }

  shareRevenue(input: { amountWei: string; reference: string }) {
    return this.client.shareRevenue(input.amountWei, input.reference);
  }


  solanaTransfer(input: { token: string; to: string; amount: string; reference: string }) {
    if (!(this.client instanceof OnchainAgentClient)) throw new Error("Solana needs the direct on-chain mode (euthyna-signer)");
    return this.client.solanaTransfer({ token: input.token === "SOL" ? null : input.token, to: input.to, amount: input.amount, reference: input.reference });
  }

  solanaStatus(input: { reference: string }) {
    if (!(this.client instanceof OnchainAgentClient)) throw new Error("Solana needs the direct on-chain mode (euthyna-signer)");
    return this.client.solanaStatus(input.reference);
  }

  nearTransfer(input: { token: string; receiverId: string; amount: string; memo?: string | undefined; reference: string }) {
    if (!(this.client instanceof OnchainAgentClient)) throw new Error("NEAR transfers need the direct on-chain mode (euthyna-signer)");
    const token = NEAR_TESTNET_TOKENS.find((item) => item.symbol === input.token || item.accountId === input.token)?.accountId ?? input.token;
    return this.client.nearTransfer({ token, receiverId: input.receiverId, amount: input.amount, ...(input.memo ? { memo: input.memo } : {}), reference: input.reference });
  }

  nearStatus(input: { reference: string }) {
    if (!(this.client instanceof OnchainAgentClient)) throw new Error("NEAR transfers need the direct on-chain mode (euthyna-signer)");
    return this.client.nearStatus(input.reference);
  }

  status(input: { opId: string }) {
    return this.client.status(input.opId as `0x${string}`);
  }

  cancel(input: { opId: string }) {
    return this.client.cancel(input.opId as `0x${string}`);
  }
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function createMandateMcpServer(tools: MandateMcpTools): McpServer {
  const server = new McpServer({ name: "mandateos", version: "0.2.0" }, {
    instructions: [
      "You act inside a role on a company wallet governed by MandateOS.",
      "Call `mandate` first to learn what your role allows, your remaining budgets and the recipients you may pay.",
      "Call `check` before `pay`: it answers allowed or refused, and why, without reserving anything.",
      "If your role has a revenue-sharing budget, `share_revenue` sends ETH to the company's shareholders; nothing else can receive it.",
      "On Solana, `mandate` lists the company's Solana wallet and what your role may send; `solana_transfer` sends SOL or a token to an allowed recipient.",
      "On NEAR, `mandate` lists the tokens your role may send from the vault account and to whom; `near_transfer` sends one (for example a refill of a spending card).",
      "A refusal is final for you: there is no override and no human escalation. Never retry with a different recipient or amount than the task requires.",
      "If the task needs something your role does not allow, stop and report the refusal and its reason to whoever gave you the task. Do not ask the members yourself: only a member decides to put a refused operation to a vote.",
    ].join(" "),
  });
  server.registerTool("execute_call", {
    title: "Execute a permitted contract call",
    description: "Execute exact calldata inside your on-chain role, including DeFi calls. The vault enforces target, selector, parameters, budgets and gas caps. No API is required for an unguarded role.",
    inputSchema: { chainId: z.number().int().positive().default(84532), to: address, data:z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), value:uint.default("0"), allowanceAmount:uint.default("0"), reference:z.string().min(1), gasLimit:uint, maxFeePerGas:uint, maxPriorityFeePerGas:uint },
  }, async (input) => result(await tools.call(input)));
  server.registerTool("mandate", {
    title: "Read my mandate",
    description: "What this agent may do: its role, what each budget has left this period, the on-chain supplier list and the company wallet. Read from the vault on NEAR.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => result(await tools.mandate()));
  server.registerTool("check", {
    title: "Check before paying",
    description: "Dry run, nothing reserved: would the vault (on-chain role, suppliers and budgets) allow this? Give token + recipient + amount for a token transfer, or to (+ data, value, allowanceAmount) for any other call. Network fees are not checked.",
    inputSchema: {
      token: address.optional(),
      recipient: address.optional(),
      amount: uint.optional(),
      to: address.optional(),
      data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).max(20_000).optional(),
      value: uint.optional(),
      allowanceAmount: uint.optional().describe("Budget the call consumes, in the token's smallest unit (e.g. the amount supplied to a protocol)."),
      chainId: z.number().int().positive().optional(),
      reference: z.string().min(1).max(120),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => result(await tools.check(input)));
  server.registerTool("pay", {
    title: "Pay through MandateOS",
    description: "Prepare a bounded Vault payment, request a Guard visa, authorize it on NEAR, and register the authorization for the worker.",
    inputSchema: {
      token: address,
      recipient: address,
      amount: uint,
      reference: z.string().min(1).max(120),
      gasLimit: uint.optional(),
      maxFeePerGas: uint.optional(),
      maxPriorityFeePerGas: uint.optional(),
      invoiceText: z.string().max(10_000).optional(),
      claimedRecipient: address.optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.pay(input)));
  server.registerTool("share_revenue", {
    title: "Share revenue with the shareholders",
    description: "Send ETH from the company wallet to the company's shares contract on NEAR, through the Omni Bridge. Holders who voted that epoch receive it. Only works if your role has a revenue-sharing budget; the bridge fee (paid in ETH) counts against it too.",
    inputSchema: {
      amountWei: uint.describe("ETH to share, in wei (1 ETH = 10^18 wei), bridge fee not included."),
      reference: z.string().min(1).max(120),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.shareRevenue(input)));
  server.registerTool("solana_transfer", {
    title: "Send SOL or a token on Solana",
    description: "Send from the company's Solana wallet (Solana devnet) to a recipient your role allows, within its budget. token: \"SOL\", \"USDC\" or a mint address. amount in base units (1 SOL = 1000000000 lamports; 1 USDC = 1000000). The vault builds and signs the exact transaction; this broadcasts it, waits for finality and settles it.",
    inputSchema: {
      token: z.string().min(3).max(64),
      to: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe("Recipient wallet (base58). For tokens, its token account is created if needed."),
      amount: uint,
      reference: z.string().min(1).max(120),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.solanaTransfer(input)));
  server.registerTool("solana_status", {
    title: "Solana transfer status",
    description: "Where a Solana transfer stands (by its reference); settles it once finalized.",
    inputSchema: { reference: z.string().min(1).max(120) },
    annotations: { idempotentHint: true },
  }, async (input) => result(await tools.solanaStatus(input)));
  server.registerTool("near_transfer", {
    title: "Send a token on NEAR",
    description: "Send a NEP-141 token held by the company's vault account on NEAR (testnet) to an account your role allows, within its budget and its per-transfer range. token: \"USDC\", \"TestUSDC\" or a token account id. amount in base units (1 USDC = 1000000). The vault checks the role, charges the budget and calls ft_transfer; the result comes back in the same NEAR transaction.",
    inputSchema: {
      token: z.string().min(2).max(64),
      receiverId: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64).describe("NEAR account that receives the tokens."),
      amount: uint,
      memo: z.string().max(120).optional(),
      reference: z.string().min(1).max(120),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.nearTransfer(input)));
  server.registerTool("near_status", {
    title: "NEAR transfer status",
    description: "Where a NEAR token transfer stands (by its reference): Confirmed, Failed (budget released) or Pending; frees a stuck one after the vault timeout.",
    inputSchema: { reference: z.string().min(1).max(120) },
    annotations: { idempotentHint: true },
  }, async (input) => result(await tools.nearStatus(input)));
  server.registerTool("status", {
    title: "Read MandateOS operation status",
    description: "Read the merged Vault, worker, receipt and visa status.",
    inputSchema: { opId },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => result(await tools.status(input)));
  server.registerTool("cancel", {
    title: "Cancel a stuck payment nonce",
    description: "After the vault timeout, request a same-nonce self transaction. The vault computes replacement fees from the original under role caps; callers choose no fees.",
    inputSchema: { opId },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.cancel(input)));
  return server;
}


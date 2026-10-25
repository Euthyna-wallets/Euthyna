import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  evmAddressBytes,
  MandateAgentClient,
  type CancellationFees,
  type PaymentRequest,
} from "@mandateos/sdk";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^\d+$/);
const opId = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export class MandateMcpTools {
  constructor(private readonly client: MandateAgentClient) {}

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

  mandate() {
    return this.client.mandate();
  }

  shareRevenue(input: { amountWei: string; reference: string }) {
    return this.client.shareRevenue(input.amountWei, input.reference);
  }


  status(input: { opId: string }) {
    return this.client.status(input.opId as `0x${string}`);
  }

  cancel(input: { opId: string } & CancellationFees) {
    return this.client.cancel(input.opId as `0x${string}`, input);
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
      "A refusal is final for you: there is no override and no human escalation. Never retry with a different recipient or amount than the task requires.",
      "If the task needs something your role does not allow, stop and report the refusal and its reason to whoever gave you the task. Do not ask the members yourself: only a member decides to put a refused operation to a vote.",
    ].join(" "),
  });
  server.registerTool("mandate", {
    title: "Read my mandate",
    description: "What this agent may do: its role, what each budget has left this period, the recipients the Guard accepts and the company wallet. Read from the vault on NEAR.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => result(await tools.mandate()));
  server.registerTool("check", {
    title: "Check before paying",
    description: "Dry run, nothing reserved: would the vault (on-chain role and budgets) and the Guard (registered suppliers, reused references) allow this? Give token + recipient + amount for a token transfer, or to (+ data, value, allowanceAmount) for any other call. Network fees are not checked.",
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
  server.registerTool("status", {
    title: "Read MandateOS operation status",
    description: "Read the merged Vault, worker, receipt and visa status.",
    inputSchema: { opId },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => result(await tools.status(input)));
  server.registerTool("cancel", {
    title: "Cancel a stuck payment nonce",
    description: "Ask the Vault, as the agent, to sign a higher-fee same-nonce cancellation and register its NEAR hash for the worker.",
    inputSchema: {
      opId,
      gasLimit: uint,
      maxFeePerGas: uint,
      maxPriorityFeePerGas: uint,
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (input) => result(await tools.cancel(input)));
  return server;
}

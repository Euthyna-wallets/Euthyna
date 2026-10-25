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
  const server = new McpServer({ name: "mandateos", version: "0.1.0" });
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

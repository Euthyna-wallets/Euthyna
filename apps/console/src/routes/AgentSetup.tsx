import { KeyPair } from "near-api-js";
import { useState } from "react";

import { API_BASE, api } from "../api.js";
import { readAgentAccessKeyRpc } from "../wallets.js";

type CreatedAgent = { apiKey: string; agent: { id: string; name: string; role: string; nearAccountId: string } };
type Provisioning = {
  status: string;
  attestation: { valid: boolean; expected: { accountId: string; publicKey: string; vaultAccountId: string; methodNames: string[]; allowanceYocto: null } } | null;
};

export type AgentReady = { name: string; role: string; nearAccountId: string; apiKey: string; keyFile: string };

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * One button: the key pair is generated here, the agent's NEAR account is created
 * with a key limited to the vault, and this browser checks that key on chain.
 */
export function NewAgent(props: { vaultAccountId: string; defaultRole?: string; defaultName?: string; onReady: (agent: AgentReady) => void }) {
  const [name, setName] = useState(props.defaultName ?? "Treasury bot");
  const [role, setRole] = useState(props.defaultRole ?? "treasury");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && /^[a-z0-9_-]{1,32}$/.test(role);

  async function create() {
    setError(null);
    let agentId: string | null = null;
    try {
      setStep("Generating the agent key in this browser…");
      const keyPair = KeyPair.fromRandom("ed25519");
      const publicKey = keyPair.getPublicKey().toString();
      setStep("Registering the agent…");
      const created = await api<CreatedAgent>("/v1/console/agents", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), role, nearPublicKey: publicKey, vaultAccountId: props.vaultAccountId, mpcPath: `agents/${role}/base` }),
      });
      agentId = created.agent.id;
      const keyFile = `${slug(name) || "agent"}-key.json`;
      download(keyFile, { networkId: "testnet", accountId: created.agent.nearAccountId, publicKey, privateKey: keyPair.toString() });
      setStep("Creating its NEAR account with a key limited to the vault…");
      const server = await api<Provisioning>(`/v1/console/agents/${created.agent.id}/provision`, { method: "POST" });
      if (!server.attestation) throw new Error("The server did not return the expected access key");
      setStep("Checking the key on chain from this browser…");
      const browser = await readAgentAccessKeyRpc(server.attestation.expected);
      if (!browser.valid) {
        const failed = browser.checks.filter((check) => !check.ok).map((check) => check.label).join(", ");
        throw new Error(`The agent key on chain does not match what was expected (${failed}). The agent was not confirmed.`);
      }
      await api(`/v1/console/agents/${created.agent.id}/provision-confirm`, { method: "POST" });
      props.onReady({ name: created.agent.name, role: created.agent.role, nearAccountId: created.agent.nearAccountId, apiKey: created.apiKey, keyFile });
    } catch (cause) {
      // A half-created agent is revoked so it never shows up as usable.
      if (agentId) await api(`/v1/console/agents/${agentId}/revoke`, { method: "POST", body: "{}" }).catch(() => undefined);
      setError(`${cause instanceof Error ? cause.message : String(cause)}${agentId ? " The agent was revoked; create it again." : ""}`);
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <label>Agent name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Job (role name)<input value={role} onChange={(event) => setRole(event.target.value.toLowerCase())} /></label>
      </div>
      <p className="small muted">
        The private key is generated in this browser and downloaded as a file. MandateOS only receives the public key.
        The agent's NEAR account can only call the vault: it cannot move NEAR or call another contract.
      </p>
      {error ? <div className="alert error">{error}</div> : null}
      <div className="row">
        <button className="primary" disabled={!valid || Boolean(step)} onClick={() => void create()}>
          {step ?? "Hire agent"}
        </button>
      </div>
    </div>
  );
}

/** Shown once after creation: the API key, as an MCP server for any agent, or as the demo agent's environment. */
export function RunYourAgent(props: { agent: AgentReady; vaultAccountId: string; onDone?: () => void }) {
  const [mode, setMode] = useState<"mcp" | "env">("mcp");
  const mcpEnv: Record<string, string> = {
    MANDATEOS_API_URL: API_BASE,
    MANDATEOS_AGENT_API_KEY: props.agent.apiKey,
    AGENT_NEAR_ACCOUNT_ID: props.agent.nearAccountId,
    AGENT_KEY_PATH: `/path/to/${props.agent.keyFile}`,
    VAULT_ACCOUNT_ID: props.vaultAccountId,
    AGENT_ROLE: props.agent.role,
    NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
  };
  const mcp = JSON.stringify({
    mcpServers: {
      mandateos: {
        command: "pnpm",
        args: ["--dir", "/path/to/MandateOS", "--filter", "@mandateos/mcp", "start"],
        env: mcpEnv,
      },
    },
  }, null, 2);
  const env = [
    `MANDATEOS_API_URL=${API_BASE}`,
    `MANDATEOS_AGENT_API_KEY=${props.agent.apiKey}`,
    `AGENT_NEAR_ACCOUNT_ID=${props.agent.nearAccountId}`,
    `AGENT_KEY_PATH=./${props.agent.keyFile}`,
    `VAULT_ACCOUNT_ID=${props.vaultAccountId}`,
    `AGENT_ROLE=${props.agent.role}`,
    "EVM_CHAIN_ID=84532",
    "NEAR_NETWORK_ID=testnet",
    "# any OpenAI-compatible model",
    "LLM_BASE_URL=",
    "LLM_MODEL=",
    "LLM_API_KEY=",
  ].join("\n");
  return (
    <section className="card secret">
      <span className="eyebrow">{props.agent.name} is hired · shown once</span>
      <h3>Plug in your agent</h3>
      <div className="row">
        <button className={mode === "mcp" ? "primary" : "ghost"} onClick={() => setMode("mcp")}>Any agent (MCP)</button>
        <button className={mode === "env" ? "primary" : "ghost"} onClick={() => setMode("env")}>Demo agent (.env)</button>
      </div>
      {mode === "mcp" ? (
        <ol className="small">
          <li>Keep <code>{props.agent.keyFile}</code> (downloaded) on the machine that runs the agent. Never upload it.</li>
          <li>Add this server to Claude Desktop, Claude Code, Cursor or Codex (MCP settings), with your paths. It contains the agent's API key, which cannot be displayed again.</li>
          <li>The agent then has the tools <code>mandate</code>, <code>check</code>, <code>pay</code>, <code>share_revenue</code>, <code>status</code> and <code>cancel</code>, and nothing else.</li>
        </ol>
      ) : (
        <ol className="small">
          <li>Keep <code>{props.agent.keyFile}</code> (downloaded) next to the agent. Never upload it.</li>
          <li>Save this as <code>.env</code>. It contains the agent's API key, which cannot be displayed again.</li>
          <li>Start it: <code>pnpm --filter @mandateos/demo-agent start</code></li>
        </ol>
      )}
      <pre>{mode === "mcp" ? mcp : env}</pre>
      <div className="row">
        <button className="primary" onClick={() => void navigator.clipboard.writeText(mode === "mcp" ? mcp : env)}>Copy</button>
        {props.onDone ? <button className="ghost" onClick={props.onDone}>I saved it</button> : null}
      </div>
      <p className="small muted">
        The agent can do nothing until a role that includes <span className="mono">{props.agent.nearAccountId}</span> is voted and out of its veto window.
      </p>
    </section>
  );
}

function download(fileName: string, content: unknown) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(content, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

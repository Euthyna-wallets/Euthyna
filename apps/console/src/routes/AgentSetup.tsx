import { KeyPair } from "near-api-js";
import { useEffect, useRef, useState } from "react";

import { API_BASE, api } from "../api.js";
import { readAgentAccessKeyRpc } from "../wallets.js";

type CreatedAgent = { apiKey: string; agent: { id: string; name: string; role: string; nearAccountId: string } };
type Provisioning = {
  status: string;
  attestation: { valid: boolean; expected: { accountId: string; publicKey: string; vaultAccountId: string; methodNames: string[]; allowanceYocto: null } } | null;
};

/** apiKey is empty with euthyna-signer: the API key went to the signer, never to this page. */
export type AgentReady = { name: string; role: string; nearAccountId: string; apiKey: string; keyMode: KeyMode; keyFile: string | null; hostname?: string | null };
type KeyMode = "signer" | "browser";

type Pairing = {
  pairingId: string;
  status: "waiting" | "pairing" | "paired" | "expired";
  name: string;
  role: string;
  accountId: string;
  expiresAt: string;
  agentId: string | null;
  publicKey: string | null;
  hostname: string | null;
  code?: string;
};

const INSTALL_URL = "https://raw.githubusercontent.com/joindefi/euthyna-signer/main/install.sh";
const MCP_PACKAGE = "@euthyna/mcp";

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
  const [keyMode, setKeyMode] = useState<KeyMode>("signer");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const finishing = useRef<string | null>(null);
  const valid = name.trim().length > 0 && /^[a-z0-9_-]{1,32}$/.test(role);

  // While a code is out, follow it: the signer redeems it, then this page finishes the hire.
  useEffect(() => {
    if (!pairing || pairing.status === "paired" || pairing.status === "expired") return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void api<Pairing>(`/v1/console/agents/pairings/${pairing.pairingId}`).then((next) => {
        if (next.status !== pairing.status) setPairing(next);
        if (next.status === "paired" && next.agentId && finishing.current !== next.agentId) {
          finishing.current = next.agentId;
          void finish(next.agentId, next, null);
        }
      }).catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [pairing?.pairingId, pairing?.status]);

  async function startPairing() {
    setError(null);
    try {
      const created = await api<Pairing>("/v1/console/agents/pairings", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), role, vaultAccountId: props.vaultAccountId }),
      });
      setCode(created.code ?? null);
      setPairing(created);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function createWithKeyFile() {
    setError(null);
    let agentId: string | null = null;
    try {
      const keyPair = KeyPair.fromRandom("ed25519");
      setStep("Generating the agent key in this browser…");
      const publicKey = keyPair.getPublicKey().toString();
      setStep("Registering the agent…");
      const created = await api<CreatedAgent>("/v1/console/agents", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), role, nearPublicKey: publicKey, vaultAccountId: props.vaultAccountId, mpcPath: `agents/${role}/base` }),
      });
      agentId = created.agent.id;
      const keyFile = `${slug(name) || "agent"}-key.json`;
      download(keyFile, { networkId: "testnet", accountId: created.agent.nearAccountId, publicKey, privateKey: keyPair.toString() });
      await finish(created.agent.id, { name: created.agent.name, role: created.agent.role, accountId: created.agent.nearAccountId, hostname: null }, { apiKey: created.apiKey, keyFile });
    } catch (cause) {
      if (agentId) await api(`/v1/console/agents/${agentId}/revoke`, { method: "POST", body: "{}" }).catch(() => undefined);
      setError(`${cause instanceof Error ? cause.message : String(cause)}${agentId ? " The agent was revoked; create it again." : ""}`);
      setStep(null);
    }
  }

  /** Creates the agent's NEAR account with a key limited to the vault, and checks it on chain from this browser. */
  async function finish(
    agentId: string,
    agent: { name: string; role: string; accountId: string; hostname: string | null },
    keyFile: { apiKey: string; keyFile: string } | null,
  ) {
    try {
      setStep("Creating its NEAR account with a key limited to the vault…");
      const server = await api<Provisioning>(`/v1/console/agents/${agentId}/provision`, { method: "POST" });
      if (!server.attestation) throw new Error("The server did not return the expected access key");
      setStep("Checking the key on chain from this browser…");
      const browser = await readAgentAccessKeyRpc(server.attestation.expected);
      if (!browser.valid) {
        const failed = browser.checks.filter((check) => !check.ok).map((check) => check.label).join(", ");
        throw new Error(`The agent key on chain does not match what was expected (${failed}). The agent was not confirmed.`);
      }
      await api(`/v1/console/agents/${agentId}/provision-confirm`, { method: "POST" });
      props.onReady({
        name: agent.name, role: agent.role, nearAccountId: agent.accountId, hostname: agent.hostname,
        apiKey: keyFile?.apiKey ?? "", keyMode: keyFile ? "browser" : "signer", keyFile: keyFile?.keyFile ?? null,
      });
    } catch (cause) {
      // A half-created agent is revoked so it never shows up as usable.
      await api(`/v1/console/agents/${agentId}/revoke`, { method: "POST", body: "{}" }).catch(() => undefined);
      setError(`${cause instanceof Error ? cause.message : String(cause)} The agent was revoked; hire it again.`);
      setPairing(null);
      setCode(null);
    } finally {
      setStep(null);
    }
  }

  const secondsLeft = pairing ? Math.max(0, Math.floor((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  const pairCommand = code ? `sudo euthyna-signer pair ${code} --api-url ${API_BASE}` : "";
  const installCommand = code ? `curl -fsSL ${INSTALL_URL} | sudo sh -s -- pair ${code} --api-url ${API_BASE}` : "";
  const locked = pairing !== null && pairing.status !== "expired";

  return (
    <div className="stack">
      <div className="row wrap">
        <label>Agent name<input value={name} disabled={locked} onChange={(event) => setName(event.target.value)} /></label>
        <label>Role<input value={role} disabled={locked} placeholder="yield-manager" onChange={(event) => setRole(event.target.value.toLowerCase().replace(/\s+/g, "-"))} /></label>
      </div>
      {role && !/^[a-z0-9_-]{1,32}$/.test(role) ? <p className="small" style={{ color: "var(--error)" }}>Role: lowercase letters, digits, "-" or "_", up to 32 characters.</p> : null}
      <fieldset className="key-mode">
        <legend>Where the agent's key lives</legend>
        <label className="check">
          <input type="radio" name="key-mode" checked={keyMode === "signer"} disabled={locked} onChange={() => setKeyMode("signer")} />
          <span><strong>euthyna-signer</strong> (recommended): the key stays with a separate system user. The AI can ask it to sign vault requests, never read the key.</span>
        </label>
        <label className="check">
          <input type="radio" name="key-mode" checked={keyMode === "browser"} disabled={locked} onChange={() => setKeyMode("browser")} />
          <span><strong>Key file</strong>: generated in this browser and downloaded. Simpler, but the AI's user can read it.</span>
        </label>
      </fieldset>
      {keyMode === "signer" ? (
        pairing && code && pairing.status !== "expired" ? (
          <div className="stack">
            <p className="small">On the machine that runs the agent, run:</p>
            <pre>{pairCommand}</pre>
            <div className="row">
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(pairCommand)}>Copy</button>
            </div>
            <p className="small muted">euthyna-signer not installed there yet? This installs it, then pairs (Linux or macOS):</p>
            <pre>{installCommand}</pre>
            <div className="row">
              <button className="ghost" onClick={() => void navigator.clipboard.writeText(installCommand)}>Copy</button>
            </div>
            <div className="alert">
              {pairing.status === "waiting"
                ? `Waiting for the signer… The code works once, for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}.`
                : step ?? `Paired with ${pairing.hostname || "the signer"}: key ${pairing.publicKey ?? ""}.`}
            </div>
          </div>
        ) : (
          <p className="small muted">
            {pairing?.status === "expired" ? "The code expired. Get a new one: " : ""}
            The console gives a one-time command. The signer makes the key on that machine and receives the API key directly: nothing to copy by hand.
          </p>
        )
      ) : (
        <p className="small muted">
          The private key is generated in this browser and downloaded as a file. Euthyna only receives the public key.
        </p>
      )}
      <p className="small muted">The agent's NEAR account can only call the vault: it cannot move NEAR or call another contract.</p>
      {error ? <div className="alert error">{error}</div> : null}
      {locked && keyMode === "signer" ? null : (
        <div className="row">
          <button
            className="primary"
            disabled={!valid || Boolean(step)}
            onClick={() => void (keyMode === "signer" ? startPairing() : createWithKeyFile())}
          >
            {step ?? (keyMode === "signer" ? (pairing?.status === "expired" ? "New code" : "Hire agent") : "Hire agent")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Shown once after creation: the API key, as an MCP server for any agent, or as the demo agent's environment. */
export function RunYourAgent(props: { agent: AgentReady; vaultAccountId: string; onDone?: () => void }) {
  const [mode, setMode] = useState<"mcp" | "env">("mcp");
  if (props.agent.keyMode === "signer") return <RunWithSigner {...props} />;
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
        // The compiled entry point: a package manager would print banners on stdout, which MCP reserves.
        command: "node",
        args: ["/path/to/MandateOS/packages/mcp/dist/server.js"],
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
          <li>Build once in the repository: <code>pnpm --filter @mandateos/sdk build && pnpm --filter @mandateos/mcp build</code>.</li>
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

/** euthyna-signer holds the key and the API key: the MCP config has no secret. */
function RunWithSigner(props: { agent: AgentReady; vaultAccountId: string; onDone?: () => void }) {
  const [client, setClient] = useState<"claude" | "json">("claude");
  const claude = `claude mcp add euthyna --env EUTHYNA_AGENT=${props.agent.nearAccountId} -- npx -y ${MCP_PACKAGE}`;
  const json = JSON.stringify({
    mcpServers: {
      euthyna: { command: "npx", args: ["-y", MCP_PACKAGE], env: { EUTHYNA_AGENT: props.agent.nearAccountId } },
    },
  }, null, 2);
  const shown = client === "claude" ? claude : json;
  return (
    <section className="card secret">
      <span className="eyebrow">{props.agent.name} is hired{props.agent.hostname ? ` · paired with ${props.agent.hostname}` : ""}</span>
      <h3>Plug it into your AI</h3>
      <p className="small">
        Its key and API key are with euthyna-signer on that machine. This config holds <strong>no secret</strong>: the vault,
        role and network are read from the signer.
      </p>
      <div className="row">
        <button className={client === "claude" ? "primary" : "ghost"} onClick={() => setClient("claude")}>Claude Code</button>
        <button className={client === "json" ? "primary" : "ghost"} onClick={() => setClient("json")}>Claude Desktop, Cursor, Codex</button>
      </div>
      <pre>{shown}</pre>
      <div className="row">
        <button className="primary" onClick={() => void navigator.clipboard.writeText(shown)}>Copy</button>
        {props.onDone ? <button className="ghost" onClick={props.onDone}>Done</button> : null}
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

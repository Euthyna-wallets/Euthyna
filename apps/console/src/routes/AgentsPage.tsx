import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { Card, PageState, Status } from "../components/ui.js";
import { omni } from "../omniroles-api.js";
import { AgentForm, AgentList } from "./OnboardingPage.js";

export function AgentsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury) });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), refetchInterval: 10_000 });
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const treasury = status.data?.treasury;
  const rolesOf = (accountId: string) => (roles.data?.roles ?? []).filter((role) => role.members.some((member) => member.member === accountId)).map((role) => role.name);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">
            An agent gets its own NEAR account that can only ask the vault for operations. Its key stays with you; MandateOS only sees the public key.
          </p>
        </div>
        {treasury && !adding ? <button className="primary" onClick={() => setAdding(true)}>New agent</button> : null}
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {!treasury ? <div className="state empty-action">Create the treasury first. <Link className="button primary" to="/onboarding">Continue setup</Link></div> : null}
      {apiKey ? (
        <section className="card secret">
          <span className="eyebrow">Agent API key · shown once</span>
          <p>Put this key in the agent's environment. It cannot be displayed again.</p>
          <pre>{apiKey}</pre>
          <div className="row">
            <button className="primary" onClick={() => void navigator.clipboard.writeText(apiKey)}>Copy API key</button>
            <button className="ghost" onClick={() => setApiKey(null)}>I saved it</button>
          </div>
        </section>
      ) : null}
      {treasury && adding ? (
        <Card title="New agent" action={<button className="ghost" onClick={() => setAdding(false)}>Close</button>}>
          <ol className="small muted">
            <li>Generate the agent key in this browser (the private key is downloaded, never sent).</li>
            <li>Create the agent: MandateOS shows its API key once.</li>
            <li>Provision its NEAR account below, then give it a role in <Link to="/roles">Roles</Link> (members vote).</li>
          </ol>
          <AgentForm
            treasury={{ vaultAccountId: treasury.vaultAccountId }}
            onCreated={(created) => {
              setApiKey(created);
              setAdding(false);
              void queryClient.invalidateQueries({ queryKey: ["agents"] });
            }}
            onError={setError}
          />
        </Card>
      ) : null}
      <Card title="Agents">
        <PageState loading={agents.isLoading} error={agents.error} empty={agents.data?.agents.length === 0} emptyContent={<div className="state">No agent yet.</div>}>
          <table>
            <thead><tr><th>Name</th><th>NEAR account</th><th>Roles</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(agents.data?.agents ?? []).map((agent) => {
                const held = rolesOf(agent.nearAccountId);
                return (
                  <tr key={agent.id}>
                    <td>{agent.name}</td>
                    <td className="mono small">{agent.nearAccountId}</td>
                    <td>{held.length ? held.join(", ") : <span className="small muted">none yet</span>}</td>
                    <td><Status value={agent.active ? "active" : "revoked"} /></td>
                    <td><Link to={`/agents/${agent.id}`}>Details</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PageState>
      </Card>
      {treasury && (agents.data?.agents.length ?? 0) > 0 ? (
        <Card title="Provisioning">
          <p className="small muted">Creates each agent's NEAR account with a key limited to vault requests, then checks that key from your browser.</p>
          <AgentList treasury={{ vaultAccountId: treasury.vaultAccountId }} onError={setError} />
        </Card>
      ) : null}
    </div>
  );
}

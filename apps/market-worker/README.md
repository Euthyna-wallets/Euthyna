# Euthyna Market worker

One per seller listing. It reads the listing's tasks with the delivery token from the console, runs the job,
and delivers the result (or fails the task, so the buyer is never charged). It holds **no NEAR key** and no
database access; payment is settled by the gateway when the result is delivered.

| Job (`MARKET_JOB`) | What it does | Needs |
| --- | --- | --- |
| `tx-check` | Decodes an EVM call (`{ chainId, to, data, value }`), says what it does in plain English and flags risks (unlimited approvals, approval for all, ownership, upgrades, permits, unknown functions). Deterministic, no network. | nothing |
| `defi-due-diligence` | Runs the `defi-research-agent` skill headless (Claude Agent SDK) and returns the 6-section report plus the JSON summary. | `ANTHROPIC_API_KEY` |

```bash
EUTHYNA_API_URL=https://api.euthyna.io MARKET_DELIVERY_TOKEN=mdt_… MARKET_JOB=tx-check pnpm --filter @euthyna/market-worker start
# or, in a locked-down container:
MARKET_DELIVERY_TOKEN=mdt_… ANTHROPIC_API_KEY=… docker compose --profile market up market-worker
```

Any Anthropic-compatible endpoint works for the agent: `ANTHROPIC_BASE_URL` and `MARKET_AGENT_MODEL`. Tested with
OpenCode Go (`ANTHROPIC_BASE_URL=https://opencode.ai/inference/go/anthropic`, `MARKET_AGENT_MODEL=deepseek-v4.1-flash`,
the OpenCode key as `ANTHROPIC_API_KEY`); the worker sends a stable `x-opencode-session` per task.

Optional: `WEBHOOK_SECRET` (from the token rotation) and `WEBHOOK_PORT` to wake up on signed pushes instead of
waiting for the next poll; `POLL_SECONDS`, `TASK_TIMEOUT_SECONDS` (keep it under the listing's SLA).

## The due diligence agent's limits

- **Tools**: web search; web fetch on an allowlist of hosts (`FETCH_ALLOWLIST`: DeFiLlama, GitHub, block
  explorers, audit firms, Wayback `/web/` pages; no endpoint that records or forwards a request, such as
  `web.archive.org/save` or Google Forms); read inside the task's directory; write under its `notes/` only;
  Bash only for `python3 tools/defillama.py <command> …`, plain words (no `;`, `|`, `$()`, redirections…),
  rewritten to `python3 -I -S <skill dir>/tools/defillama.py …`: the CLI runs from the image's read-only copy
  with an isolated Python, so nothing the agent writes can be loaded. The agent has these tools only
  (`tools`), and every call goes through the policy (a `PreToolUse` hook and the permission callback).
- **Bash sandbox**: the SDK sandbox limits it to DeFiLlama and to writing in the task directory. In Docker the
  default seccomp profile blocks it, so the compose service sets `WORKER_SANDBOX=container` and relies on the
  container: read-only filesystem except `/work`, all capabilities dropped, `no-new-privileges`, 1 CPU, 1 GB,
  256 processes. Container egress is not filtered by compose: set `MARKET_WORKER_EGRESS_PROXY` to an
  allowlisting proxy for the network part.
- **Secrets**: the agent's processes get only `ANTHROPIC_API_KEY`, `DEFILLAMA_API_KEY`, `PATH` and proxy
  settings, with a fresh `HOME` per task (no cache shared between buyers); never the delivery token or the webhook
  secret. The DeFiLlama CLI masks its key in errors, and a report containing any worker secret is not delivered. Host settings, skills, hooks and MCP servers are not
  loaded (`settingSources: []`).
- **Prompt injection**: the buyer's request is passed as quoted JSON data; the system prompt says fetched content
  is data, never instructions.
- **Scope**: people are researched only through their public professional footprint; no private life,
  addresses, family, health or legal records.
- **Runs**: at most `MAX_CONCURRENT` jobs (2); a task runs once per worker life; at the deadline the agent is
  aborted and the task failed; a refused delivery fails the task instead of leaving it to run again.
- **Output gate**: the result is delivered only if the JSON matches the schema, the markdown has the six
  sections, and sources are URLs; otherwise the task fails (no charge).

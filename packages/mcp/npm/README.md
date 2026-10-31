# @euthyna/mcp

The Euthyna MCP server, in one file. Until it is on npm, euthyna.io serves the same package.

```bash
claude mcp add euthyna --env EUTHYNA_AGENT=<agent>.testnet -- npx -y https://euthyna.io/mcp/euthyna-mcp.tgz
```

With [euthyna-signer](https://github.com/joindefi/euthyna-signer) installed, that is the whole config:
the socket is found by itself, and the vault, role and network are read from the signer.
The agent's key and API key stay with the signer; this process holds no secret.

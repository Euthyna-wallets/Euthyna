# Public pages

Two pages of the console work without signing in; the landing is the home page and the console overview moved to `/overview`. They read NEAR directly
from the browser; the MandateOS API is not involved.

| Page | What it reads |
| --- | --- |
| `/` (and `/explore`) | the landing, then `list_companies` on the registry (`docs/registry.md`) |
| `/c/<dao>` | `get_company` on the registry; the vault's access keys and wallets; the treasury: NEAR in the DAO, ETH, USDC and wNEAR in the company wallets on Base and Ethereum, valued at CoinGecko market prices; revenue paid to voters from `info` of the shares contract |

The registry is `VITE_MANDATEOS_REGISTRY_ID` (default `registry.mandateos.testnet`)
and the RPC is `VITE_NEAR_RPC_URL`.

The illustrations in `apps/console/public/landing/` are original isometric
scenes made for MandateOS.

Some activities shown on the landing are not built yet: Solana and Bitcoin
wallets, a bank account, trading on Hyperliquid or stocks, security work and
freelance missions. Today agents work on NEAR, Base and Ethereum, with three
jobs: paying suppliers, sharing revenue, and Uniswap swaps.

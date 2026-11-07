# Public directory of AI companies

`contracts/registry` is the list of Euthyna companies that anyone can read on
chain. The website reads it to show the companies; it does not need the
Euthyna API for that.

## Who can list what

| | |
| --- | --- |
| Who lists | the company's DAO calls `register`, so a vote of its members decides it |
| Which DAOs | only `<name>.<factory>`, the accounts one DAO factory creates (`sputnikv2.testnet` on testnet) |
| Which vaults | when a vault factory is set, only `<name>.<vault factory>`: the keyless vaults Nomos creates (`euthyna-nomos.testnet`) |
| What is checked | `owner_id` of the vault must be the DAO; `info().dao_id` of the shares contract (if any) must be the DAO |
| What is stored | DAO, vault, shares contract, name (64 characters), one line of description (280) |
| Leaving | the DAO calls `unregister`; its storage deposit comes back |
| Changing the list | nobody else: the registry account has no access key |

A company cannot list itself with another company's vault or shares, an
account outside the factory cannot list anything, and a vault Nomos did not
create is refused (`ERR_NOT_A_FACTORY_VAULT`). When a check fails, the
registry logs the reason (`ERR_VAULT_NOT_OWNED_BY_DAO`, `ERR_SHARES_NOT_OF_DAO`,
`ERR_STORAGE_DEPOSIT`) and refunds the whole deposit.

The factory itself keeps no list, and it has no access key, so it cannot be
changed to keep one. That is why the directory is a separate contract.

## Views

- `list_companies({from_index?, limit?})`: up to 100 at a time
- `get_company({dao_id})`
- `company_count()`
- `factory_id()`, `vault_factory_id()`

## In the console

**Settings → Public directory**: name and one line of description, then
**Propose the listing**. The browser checks on chain that the vault is owned by
the DAO and that the shares contract belongs to it, rebuilds the vote, and only
then the wallet signs. Members approve it in **Decisions**. The API needs
`OMNIROLES_REGISTRY_ID`.

## On testnet

### Current: `euthyna-directory.testnet` and Nomos `euthyna-nomos.testnet` (2026-11-07)

The owner key of `euthyna.testnet` was lost, so `nomos.euthyna.testnet` can no
longer publish a version, and its vaults fetch versions only from it: they stay
on their code (without the B6 fix). Vault versions now carry `SetCodeSource`, a
rule change the DAO votes like the others, so a vault no longer depends on one
Nomos key: an upgrade still deploys only code with the voted hash.

The new Nomos and directory run the CI builds of `contracts/res/nomos.wasm` and
`contracts/res/registry.wasm`; both accounts have no access key. The Nomos owner
is `euthyna-owner.testnet` (it publishes versions, nothing else); its key is
kept offline, not on the server.

| Step | Result | Transaction |
| --- | --- | --- |
| Create `euthyna-owner.testnet`, `euthyna-nomos.testnet`, `euthyna-directory.testnet` (temporary keys) through the testnet registrar | | `4mdccxutw8nbQStRU8F5zqN3mJcgk8x8hcBowp2jsuwj`, `FxS4dcatwdvRgiAeAP6L31TcXZBcEh7PZEdwnyFEuqU5`, `3vC57821uRyUj8kTDmKMaqxfM63zpBHMw1UD4YAedU64` |
| Nomos: deploy + `new(euthyna-owner.testnet)` + delete the key, in one transaction | 0 access keys; code hash `4m1piZgmebAmqjwDyjtRPPycc3mfUZkG4QHfviWjjxMz` | `6noQ5MUPzDtjcyxPs13sVtQfRM8f9bKcAexNpBCan4kz` |
| Directory: deploy + `new(sputnikv2.testnet, euthyna-nomos.testnet)` + delete the key, in one transaction | 0 access keys; code hash `GKmygErEviqFHAjsELMrJeJbsseopZp3hNT7wtDN73hk` | `AKx7VZLbrDesAoiGqxq5MDEGt72wKcmDArftF5iMA4mA` |
| Publish `contracts/res/vault.wasm` (sha256 `f1e1c20f…7a8`) | version `HHCvArrQ1T9GTdN9DTLnPMqVmXHSqUGWYwMdkjHXBnq5` | `DtBWvGDVPi8rwQrintoTrG2yiacon3Lm2auog9L2pyTQ` |

The API and the console use `euthyna-directory.testnet` on testnet and still
read `atlantis-registry.testnet` (`OMNIROLES_PREVIOUS_REGISTRY_IDS`,
`VITE_MANDATEOS_PREVIOUS_REGISTRY_IDS`): a company lists in the directory whose
Nomos made its vault.

### Previous: `atlantis-registry.testnet` (2026-11-01)

Same code and settings as `euthyna-registry.testnet` below (DAO factory
`sputnikv2.testnet`, vault factory `nomos.euthyna.testnet`), redeployed from the
CI build. `euthyna-registry.testnet` runs a `registry.wasm` built outside the CI
container: it embeds `/root/.cargo/...` paths where the CI build embeds
`/home/near/.cargo/...`, so its code hash (`7Eu99o...`) is not what the
repository builds, and the account has no key to replace it. The checked-in
`contracts/res/registry.wasm` is now the CI build, and that is what runs here.

| Step | Result | Transaction |
| --- | --- | --- |
| Create the account (temporary key) through the testnet registrar | | `GTaunR2AeUcKRppmWhNQAsEJQUZ38A38C41NNoXBhx77` |
| Deploy + `new(sputnikv2.testnet, nomos.euthyna.testnet)` + delete the key, in one transaction | 0 access keys; code hash `GKmygErEviqFHAjsELMrJeJbsseopZp3hNT7wtDN73hk` = base58(sha256 of `contracts/res/registry.wasm`) | `HVyxiJ9wkNGfoU83wDZEMS4QSnPSzcgWpE7pfCiFWLKn` |

Companies listed on the previous registry list themselves again here, by a
vote of their members.

Companies with a vault from `nomos.euthyna.testnet` stay listed here.

### Previous: `euthyna-registry.testnet` (2026-10-31)

DAO factory `sputnikv2.testnet` (the official Sputnik factory), vault factory
`nomos.euthyna.testnet`. The testnet registrar creates a top-level account only
with a key, so the account was created with a temporary key, then one
transaction deployed the code, initialised it and deleted that key. Since then
the account has no access key.

| Step | Result | Transaction |
| --- | --- | --- |
| Create the account (temporary key) | | `AhLVgaLxckQtbhHaCX4P9uuN7H4AHGNb3v2Lark3c5UW` |
| Deploy + `new` + delete the key, in one transaction | 0 access keys; code hash `7Eu99o8d92yJb3AH7X4aQJEGPzfvEJp5Cr2J7SDNG4gG` (a build outside the CI container, see above) | `4FYnowncAjwwZNivydq22X5Mtoen4SzaaGJnrmyCa5AF` |
| An account that is not a DAO lists E2E Buyer AI | refused, `ERR_NOT_A_MANDATEOS_DAO` | |
| E2E Buyer AI members vote the listing with its vault and shares (proposal #7) | listed, `company_count` 1 | `7BbsJXyJmdXoYauLfAKCPQHeeaoXeeYxuTGYvsLudwqV` |

### First deployment: `registry.mandateos.testnet` (2026-10-25)

Factory `factory-v2.mandateos.testnet`, the DAO factory of the first
deployment. Companies created since then use `sputnikv2.testnet`, so this
registry cannot list them; it keeps Atlas Labs and ACME AI. Created, funded,
deployed and initialised in one transaction with no `AddKey`.

| Step | Result | Transaction |
| --- | --- | --- |
| Create + deploy + `new` | 0 access keys; code hash `5j7m4A77ouHUjZGwYEzu6TYiqEL5GG8Rwu2h4Z95xRuC` | `9vRRAXDLQo4TxEcNkAdots5BeRRjT2qDdhxvELog7DPy` |
| Atlas Labs members vote the listing (proposal #13) | Approved, `registered atlas-labs.factory-v2.mandateos.testnet` | `CSmuZNP23iALw6VCZREq8kHowS6cgF4YxaenspbrA3Bz` |
| A member account (not a DAO) lists Atlas's vault as "Fake Atlas" | refused, `ERR_NOT_A_MANDATEOS_DAO`; `company_count` stays 1 | receipt `EH5SfsDp241HNKVDMTnwSEhhJbcX1ZQmresKAoMstDnT` |

## Tests

`contracts/tests/tests/registry.rs` (NEAR sandbox): a company lists itself and
gets the unused deposit back; an account outside the factory is refused; a
company claiming another company's vault or shares is refused; a too small
deposit is refunded; a company updates its listing and leaves; with a vault
factory set, a vault outside it is refused and a Nomos vault is listed.

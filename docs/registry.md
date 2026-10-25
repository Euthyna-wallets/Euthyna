# Public directory of AI companies

`contracts/registry` is the list of MandateOS companies that anyone can read on
chain. The website reads it to show the companies; it does not need the
MandateOS API for that.

## Who can list what

| | |
| --- | --- |
| Who lists | the company's DAO calls `register`, so a vote of its members decides it |
| Which DAOs | only `<name>.<factory>`, the accounts the MandateOS DAO factory creates |
| What is checked | `owner_id` of the vault must be the DAO; `info().dao_id` of the shares contract (if any) must be the DAO |
| What is stored | DAO, vault, shares contract, name (64 characters), one line of description (280) |
| Leaving | the DAO calls `unregister`; its storage deposit comes back |
| Changing the list | nobody else: the registry account has no access key |

A company cannot list itself with another company's vault or shares, and an
account outside the factory cannot list anything. When a check fails, the
registry logs the reason (`ERR_VAULT_NOT_OWNED_BY_DAO`, `ERR_SHARES_NOT_OF_DAO`,
`ERR_STORAGE_DEPOSIT`) and refunds the whole deposit.

The factory itself keeps no list, and it has no access key, so it cannot be
changed to keep one. That is why the directory is a separate contract.

## Views

- `list_companies({from_index?, limit?})`: up to 100 at a time
- `get_company({dao_id})`
- `company_count()`
- `factory_id()`

## In the console

**Settings → Public directory**: name and one line of description, then
**Propose the listing**. The browser checks on chain that the vault is owned by
the DAO and that the shares contract belongs to it, rebuilds the vote, and only
then the wallet signs. Members approve it in **Decisions**. The API needs
`OMNIROLES_REGISTRY_ID`.

## Tests

`contracts/tests/tests/registry.rs` (NEAR sandbox): a company lists itself and
gets the unused deposit back; an account outside the factory is refused; a
company claiming another company's vault or shares is refused; a too small
deposit is refunded; a company updates its listing and leaves.

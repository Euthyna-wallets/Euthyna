# Checklist UAT manuelle — Meteor + MetaMask

Objectif : rejouer le parcours console sur **NEAR testnet + Base Sepolia**, sans
clé privée côté serveur. Cocher dans l'ordre ; chaque étape indique le résultat
attendu.

## 0. Pré-requis

| Élément | Quantité / valeur |
|---|---|
| Comptes NEAR council | 3 (Meteor), dont le fondateur |
| Comptes EVM council | 3 adresses (MetaMask), dont `0x1D693a4425bf7eD10FE7775E2b65b072019FFceb`, seuil Safe **2/3** |
| NEAR fondateur | **≥ 10 NEAR** pour la factory + **5 NEAR** par Vault/relay |
| NEAR total conseillé | **19 NEAR** (DAO 7,5 + Vault 5 + relay 5 + agent/propositions) |
| ETH Base Sepolia (owner 1) | **≥ 0,01 ETH** (Safe + 3 modules + batch Safe) |
| TestUSDC Base Sepolia | 10 unités sur le Safe (`0x418A2b47911dE05e21688F7490195F5324B49474`) |
| Test FT NEAR | 10 unités vers le DAO (`test-ft-v4.mandateos-root-20261021.testnet`, `mint` public) |
| Serveur | API + PostgreSQL + console (`CONSOLE_ORIGIN=http://localhost:5173`) |

MetaMask : ajouter le réseau Base Sepolia (chain id `84532`, RPC
`https://sepolia.base.org`). Meteor : réseau testnet.

## 1. Organisation

1. Ouvrir `http://localhost:5173`.
2. Créer le compte (e-mail + mot de passe) puis ajouter la passkey.
3. Se reconnecter avec la passkey.
4. Créer l’entreprise.
5. Inviter Alice et Bob (liens affichés), accepter chaque lien dans une session
   distincte.
6. Chaque membre clique **Use connected NEAR account** et **Use connected EVM
   account**, puis **Link my wallets**.

Attendu : 3 membres, 3 comptes NEAR, 3 adresses EVM, rôle `owner` pour le
fondateur.

## 2. Trésorerie

1. Saisir le compte NEAR du fondateur, cliquer **Build plan**.
2. Vérifier le DAO (`<slug>.sputnikv2.testnet`), le seuil **2**, Vault, relay,
   0xGOV, Safe/Roles/Delay.
3. **Sign DAO creation** (Meteor, ~7,5 NEAR).
4. **Sign Vault + relay deployment** (Meteor, 2×5 NEAR).
5. **Deploy Safe + modules** (MetaMask owner 1).
6. **Prepare Safe batch**, **Sign as owner** avec owner 1, changer de compte
   MetaMask, **Sign as owner** avec owner 2, puis **Execute Safe batch**.
7. **Verify and register treasury**.

Attendu : trésorerie `active` (ou `pending_dao_hardening` si l’auto-update est
encore actif).

## 3. Hardening DAO

1. Cliquer **Propose auto_update=false** (Meteor, bond 0,1 NEAR).
2. Dans Trezu ou via Meteor, voter **Approve** avec un deuxième council.
3. Attendre l’exécution de la proposition.
4. Dans la console, cliquer **Re-run verification**.

Attendu : statut `active`, création d’agent débloquée.

## 4. Agent

1. Créer un compte NEAR `compta-bot.<root>` avec une **function-call key**
   limitée au Vault, générée côté client.
2. Renseigner nom, compte NEAR, clé publique ed25519, rôle `researcher`.
3. **Create agent** ; conserver l’API key affichée une seule fois.
4. Ajouter la clé au Vault via la proposition `add_key` (Trezu) et voter.
5. Vérifier la fiche agent (`On-chain state`).

## 5. Mandat

1. Ouvrir **Agent mandate**, saisir rôle, `maxPerTx`, budget, période,
   destinataires, token TestUSDC.
2. **Preview mandate** : vérifier le diff, les 3 artefacts et le statut agent.
3. Signer chaque proposition avec Meteor (Vault `set_role`, financement, relay
   0xGOV→Delay).
4. Voter les propositions dans Trezu (2/3).
5. Attendre le cooldown Delay (**300 s** sur Sepolia).
6. Exécuter la file Delay (n’importe qui) et vérifier la permission Zodiac.

## 6. Paiement

1. Financer le budget du Vault en Test FT (`ft_transfer_call` via le DAO).
2. Déposer 3 TestUSDC sur le Safe et laisser l’allowance Zodiac.
3. L’agent appelle `prepare` (SDK/MCP), Guard délivre le visa, l’agent appelle
   `authorize`.
4. Le worker relayer diffuse la transaction, attend le receipt et confirme le
   rapport Guard.
5. Vérifier 1 TestUSDC reçu par le fournisseur, l’état `Confirmed` et la fiche
   agent mise à jour.

> Cette étape dépend de #6 (`POST /v1/operations/pay`, worker relayer). Tant
> qu’elle n’est pas livrée, le paiement se fait avec le script existant.

## Blocages connus

- La console headless n’a ni Meteor ni MetaMask : utiliser un vrai navigateur.
- Les clés du council UAT ne doivent pas être réutilisées hors testnet.
- Le plan actuel demande 10 NEAR par contrat ; réduire seulement après mesure
  réelle du stockage.

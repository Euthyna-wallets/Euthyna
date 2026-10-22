# Checklist UAT manuelle — Meteor + MetaMask

Objectif : rejouer le parcours console sur **NEAR testnet + Base Sepolia**, sans
clé privée côté serveur. Cocher dans l'ordre ; chaque étape indique le résultat
attendu.

> Création de compte : e-mail + passkey uniquement. Aucun mot de passe n’est créé ;
> les routes `/sign-up/email` et `/sign-in/email` renvoient 404.

## 0. Pré-requis

| Élément | Quantité / valeur |
|---|---|
| Comptes NEAR council | 3 (Meteor), dont le fondateur |
| Comptes EVM council | 3 adresses (MetaMask), dont `0x1D693a4425bf7eD10FE7775E2b65b072019FFceb`, seuil Safe **2/3** |
| Company + DAO | **0,25 NEAR** via `factory-v2.mandateos.testnet` + Sputnik global immuable |
| Treasury complète | **8,75 NEAR** : DAO 0,25 + Vault 5 + relay 3,5 ; dépôts de stockage |
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
2. Vérifier la DAO `<slug>.factory-v2.mandateos.testnet`, les trois membres et le
   seuil absolu **2** affichés avant signature.
3. Cocher la confirmation de policy, connecter exactement le wallet du
   fondateur, puis **Sign and create DAO** (0,25 NEAR depuis le wallet client
   sponsorisé).
4. Cliquer **Read get_policy directly from NEAR RPC**, puis confirmer chaque
   membre observé et le seuil. Vault/relay restent bloqués avant ces confirmations.
5. **Deploy Vault + relay (MandateOS pays)**, puis déployer Safe + modules.
6. Préparer le batch Safe, collecter deux signatures et exécuter.
7. Vérifier et enregistrer la Treasury.

Attendu : Treasury `active`. `auto_update=true` apparaît comme avertissement
non bloquant pour cette factory keyless et son hash global immuable.

## 3. Hardening DAO optionnel

1. Cliquer **Propose auto_update=false (optional)** (bond 0,1 NEAR).
2. Voter **Approve** avec deux comptes council.
3. Vérifier la proposition dans l'UI Sputnik officielle de Trezu configurée
   pour testnet. Le backend hébergé `testenv.trezu.app` ne permet pas encore
   d'indexer un suffixe factory personnalisé.

Ce vote est de la défense en profondeur ; il ne bloque plus la Treasury.

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

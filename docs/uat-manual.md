# Checklist UAT manuelle — Meteor + MetaMask

Objectif : rejouer le parcours console sur **NEAR testnet + Base Sepolia**, sans
clé privée côté serveur. Cocher dans l'ordre ; chaque étape indique le résultat
attendu.

> UAT hackathon : email identifiant + passkey créée directement. Aucun email
> externe, aucun lien magique, aucun mot de passe.

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

1. Démarrer la console avec `VITE_UAT_DEMO_MODE=1` et l'API avec
   `UAT_DEMO_WALLETS_ENABLED=1`. Les deux flags restent désactivés par défaut.
2. Ouvrir `http://localhost:5173`, saisir nom + email et créer la passkey.
3. Créer l'entreprise.
4. Ajouter Alice et Bob avec leurs comptes NEAR/EVM publics. Ils apparaissent
   `pending` et ne comptent pas encore dans le council.
5. Chaque membre ouvre son lien `/onboarding?member=<id>`, se connecte avec sa
   passkey, puis signe le même défi avec son wallet NEAR (NEP-413) et son wallet
   EVM (EIP-191).
6. Vérifier que chaque ligne affiche `proved`. Aucun compte NEAR n'est encore
   créé ou financé.

En mode normal, utiliser NEAR Wallet Selector et MetaMask/Rabby. Vérifier
qu'aucune clé privée n'apparaît dans localStorage.

Attendu : 3 membres prouvés, 3 comptes NEAR, 3 adresses EVM, rôle `owner` pour
le fondateur. Ajouter une quatrième déclaration sans signer : elle doit rester
hors du plan et le seuil doit rester **2/3**.

## 2. Trésorerie

1. Saisir le compte NEAR du fondateur, cliquer **Build plan**.
2. Vérifier la DAO `<slug>.factory-v2.mandateos.testnet`, les trois membres et le
   seuil absolu **2** affichés avant signature.
3. Cocher la confirmation de policy et cliquer **Sign and create DAO**. En mode
   démo, l'API réserve le sponsoring journalier, crée/finance alors seulement le
   wallet client (0,5 NEAR), puis le navigateur signe et attache 0,25 NEAR.
4. Cliquer **Read get_policy directly from NEAR RPC**, puis confirmer chaque
   membre observé et le seuil. Vault/relay restent bloqués avant ces confirmations.
5. **Deploy Vault + relay (MandateOS pays)**.
6. Depuis la session de chaque membre prouvé, cliquer **Verify by direct RPC and
   confirm as this member**. Vérifier les `code_hash`, zéro access key,
   `owner_id`, MPC/path, chain, token, Guard/TTL et delay. Safe reste bloqué
   jusqu'à 3/3 confirmations sur le même digest.
7. Déployer Safe + modules, préparer le batch Safe, collecter deux signatures
   et exécuter.
8. Vérifier et enregistrer la Treasury. Le serveur doit aussi refuser
   `register` si une confirmation manque.

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

1. Sur la machine agent, lancer `mandateos agent init --name "Compta Bot"`.
   Vérifier le fichier `AGENT_KEY_PATH` en mode `0600`; copier uniquement
   `publicKey`.
2. Dans **Register agent**, renseigner nom, clé publique et rôle
   `researcher`, puis créer l'identité/API key. Le compte proposé est
   `compta-bot-agent.<parent>`.
3. Cliquer **Provision**. L'API crée et finance le compte avec une seule
   transaction, puis le navigateur lit directement `view_access_key_list`.
4. Vérifier exactement une clé `FunctionCall`, receiver = Vault,
   `allowance = null` et méthodes `prepare`, `authorize`, `cancel_nonce`,
   `request_derived_public_key`; confirmer dans la console.
5. Vérifier que le solde gas NEAR n'est pas sous le seuil. S'il est bas,
   envoyer un simple transfert NEAR au compte agent existant ; ne jamais
   ajouter ou remplacer sa clé.
6. Dans le mandat, exécuter/voter `set_role` avant `register_agent`.
7. Démarrer le SDK. Il doit voir l'agent enregistré, appeler une seule fois
   `request_derived_public_key`, puis afficher `0xAAA` dans la fiche agent.
   Avant `register_agent`, le SDK et l'UI doivent afficher l'erreur explicite et
   ne pas appeler `prepare`.

## 5. Mandat

1. Ouvrir **Agent mandate**, connecter le compte NEAR d'un membre du council,
   puis saisir rôle, `maxPerTx`, budget, période, destinataires et token
   TestUSDC.
2. Dans **Budget token (UAT)**, vérifier `TestUSDC`, `6` décimales et le solde
   FT de la DAO. Cliquer **Register storage and mint test budget** : le wallet
   signe `storage_deposit` pour la DAO et le Vault uniquement s'ils manquent,
   puis `mint` vers la DAO. Recharger l'état et vérifier le nouveau solde.
3. **Preview mandate** : vérifier le diff, les trois artefacts et le statut
   agent.
4. Exécuter strictement `set_role → register_agent → financement → Zodiac`.
   Pour chaque ligne, proposer puis faire voter deux membres. La ligne suivante
   reste désactivée jusqu'à ce que `get_proposal` affiche **Executed**.
5. Vérifier qu'une proposition `Failed` ou `Expired` affiche **Re-propose** et
   ne débloque pas l'étape suivante.
6. Attendre le cooldown Delay (**300 s** sur Sepolia).
7. Exécuter la file Delay (n’importe qui) et vérifier la permission Zodiac.

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

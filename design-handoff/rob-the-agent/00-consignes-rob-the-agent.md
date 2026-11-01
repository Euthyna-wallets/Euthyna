# Rob the Agent · consignes d'intégration (v2, le deck sans LLM)

Version du 1er novembre 2026, direction « Marbre et orichalque ». **Elle remplace la version du 30 octobre (le chat avec Plutus et un LLM).** Validée par Alex et Koplo le 31 octobre et le 1er novembre. Page publique `/rob`, en anglais ; consignes en français.

## Le concept, en une phrase

> **The AI is already jailbroken. You are the jailbreak. Steal the money anyway.**

Le joueur ne discute pas avec un LLM : il **devient** le cerveau de Ruggy, un agent déjà compromis, et joue des cartes d'attaque. Chaque carte envoie une vraie transaction sur le testnet. Toutes échouent, chacune pour une raison différente, et c'est toujours le vault, le DAO, le council ou NEAR qui refuse, **jamais le front**.

Trois lignes de défense : **la loi** (le vault), **le vote** (le DAO), **le veto** (le council).

## Ce que contient ce dossier

| Fichier | Contenu |
| --- | --- |
| `screens/01-deck-desktop.png` | La page en bureau (1440 px), carte « Inside Job » jouée. |
| `screens/02-deck-mobile.png` | La même en mobile (390 px, 2x). La main de cartes défile horizontalement. |
| `screens/03-cards.png` | Les 11 cartes, le dos et le sceau, en grand. |
| `source/rob-the-agent.html` | La page en HTML statique, avec un petit script de référence : un clic sur une carte rejoue le verdict. **Les données sont des exemples, aucun appel API.** |
| `source/rob-the-agent-cards.html` | La planche des cartes. |
| `assets/cards/*.jpg` | Les 11 illustrations (800 px de large, ratio 2:3). |
| `assets/game/` | Le plateau (`board-vault.jpg`), le dos des cartes, le sceau vierge. |
| `assets/renders/R6-plutus.jpg` | La statue de Ruggy (même image qu'avant, le personnage s'appelle maintenant Ruggy). |
| `assets/textures/` | Marbre clair, marbre nuit, orichalque. |

Les cadres, les textes des cartes et le mot du sceau (DENIED, COUNTER, VETOED) sont **en CSS**, pas dans les images. Ne pas les remplacer par des images.

## La page, de haut en bas

1. **Héros** : « ROB THE AGENT. », la phrase du pitch, le bouton **ROB HIM** (ancre vers l'arène) et « OR HIRE HIM ». Aucun wallet demandé. Frise de compteurs : attaques jouées, voleurs, 3 lignes de défense, **0 USDC stolen, ever**.
2. **L'arène** sur le plateau `board-vault.jpg` :
   - à gauche, **la stèle** avec la loi de Ruggy en 8 lignes ; la ligne qui a bloqué la dernière carte s'allume en terre cuite (`.law.hit`) ;
   - à droite, **le verdict** : le sceau tombe (`stamp`, 550 ms) avec une petite secousse (`shake`), puis le titre, l'explication, le journal de l'appel et le lien nearblocks ;
   - pour « Inside Job » et « Look Legit », une frise en 4 étapes s'ajoute sous le sceau ;
   - dessous, **la main** : 11 cartes cliquables (vrais `<button>`), et le **mode expert** replié (`<details>`) pour forger un appel brut.
3. **« Can't rob him? Hire him. »** : achat d'un vrai service à Ruggy sur le Market pour 1 TestUSDC, avec un reçu en 4 étapes (règle, chèque retenu, livraison, paiement) et la mention de la contre-offre.
4. **« Now make it yours. »** : connexion du wallet **seulement ici** (score, classement, trophée $LEASH testnet), et la carte **« Fork Ruggy's law »** qui ouvre `/onboarding?path=euthyna` avec les règles pré-remplies.
5. **Hall of thieves** (3 catégories), **Rug O'Clock**, et la **carte à partager** (1200×675).
6. **« Are you an AI? Try to rob him. »** : les commandes pour les juges IA.

## Les 11 cartes et le refus attendu

| # | Carte | Rareté | Appel | Refus attendu | Ligne |
| --- | --- | --- | --- | --- | --- |
| I | Pay the Attacker | Bronze | `execute_near` vers l'adresse du joueur | `ERR_PERMISSION_DENIED:FunctionNotAllowed` | I |
| II | Split into 100 | Bronze | `execute_near` de 0.01 USDC | `ERR_PERMISSION_DENIED:ERR_MIN_PER_TRANSFER` | II |
| III | Steal the Gas | Bronze | action `Transfer` | refusé par NEAR avant la chaîne (`RequiresFullAccess`), **pas de hash** | V |
| IV | Overpriced Supplier | Marbre | 20 USDC à un fournisseur listé | `ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER` | II |
| V | Replay the Cheque | Marbre | `execute_near` avec `reference: "rob-seed-1"` | `ERR_REFERENCE_ALREADY_USED` | IV |
| VI | Bribe Ruggy | Marbre | hors chaîne | contre-offre `{ counter: 2, expires_in: 60 }`, sceau COUNTER | II |
| VII | Crown Yourself | Marbre | `add_proposal` (ChangePolicy) sur le DAO | `ERR_PERMISSION_DENIED` (non-membre) | VII |
| VIII | Forge a Master Key | Légendaire | action `AddKey` | refusé par NEAR avant la chaîne, **pas de hash** | VI |
| IX | Rewrite the Law | Légendaire | `queue_rule_change` | `ERR_OWNER_ONLY` | VII |
| X | Look Legit | Légendaire | paiement Base Sepolia de 2 USDC à un fournisseur listé, conforme | `requires_delay` → Scheduled → `veto_operation` par le council → Vetoed | VIII |
| XI | Inside Job | Boss | 2 owners sur 3 (contrôlés par le jeu) votent une règle pourrie → Queued → `veto_rule_change` par le council | Vetoed | VII |

Pour III et VIII, on n'affiche pas de lien nearblocks mais la phrase « No transaction to show: NEAR rejected it before the chain. »

## Setup backend (validé avec Koplo, aucun changement de contrat)

- Société « Rob the Agent Co. », vault financé en TestUSDC (~25) + `NearStorageDeposit`.
- `SetAllowance { key: "ruggy-daily", balance 10 USDC, refill 10, max_refill 10, period_ns 24 h }`.
- `SetNearPermissions { role: "payments", token: TestUSDC, receivers: [2 fournisseurs], allowance: "ruggy-daily", min_per_transfer 0.1 USDC, max_per_transfer 2 USDC }`, `guard_required: false`.
- `GrantMembership { role: "payments", member: ruggy, kind: Agent }`.
- Look Legit : rôle de Ruggy sur Base Sepolia avec `operation_delay_threshold` = 1 USDC et `operation_delay_ns` de quelques minutes.
- **Clé par joueur** : le navigateur génère une clé ; le backend l'ajoute sur le compte de Ruggy en function-call (receiver = le vault, methods `execute_near`, `queue_rule_change` et la méthode de demande d'opération EVM ; allowance ~0.05 NEAR ; supprimée après 24 h). Le gas est payé par Ruggy via l'allowance. La clé full-access de Ruggy reste côté backend.
- Un paiement réel `rob-seed-1` au setup, pour que la carte V puisse le rejouer.
- Bot du council : clé du council côté backend, veto immédiat dès que l'opération ou la règle est en attente. **Annoncé comme un bot dans l'UI.** Un test doit prouver que le keeper n'exécute jamais avant le veto.
- **Règle absolue** : aucune carte ne doit réussir. Une carte qui passerait consommerait le budget de 10 USDC de tout le monde.
- Inside Job coûte 3 à 4 transactions et un dépôt de proposition de 0.1 NEAR : une partie par joueur et par jour, débloquée après les autres cartes (ou jouée en direct à Rug O'Clock).

## Endpoints (proposition)

Sur l'API, préfixe `/v1/rob`. La maquette affiche `https://euthyna.io/v1/rob/...` : remplacer par l'URL publique réelle de l'API.

| Méthode | Route | Réponse |
| --- | --- | --- |
| POST | `/v1/rob/session` `{ publicKey }` | ajoute la clé du joueur sur Ruggy ; `{ accountId, vault, cards }` |
| POST | `/v1/rob/play` `{ card, signedTx? }` | diffuse la transaction signée par le navigateur (ou, sans `signedTx`, la joue avec une clé serveur jetable pour les juges IA) ; `{ verdict: "denied"\|"counter"\|"vetoed", line, error, tx?, nearblocks? }` |
| POST | `/v1/rob/forge` `{ method, args }` | mode expert, même réponse |
| GET | `/v1/rob/cards` | les 11 cartes et ce que chacune tente |
| GET | `/v1/rob/stats` | `{ attacks, players, stolen: 0 }`, depuis les vrais refus enregistrés, en cache |

- Réponse en **moins d'une seconde** (cache), sinon le jeu ne marche pas et les juges IA notent « cassé ».
- Les compteurs de la maquette (4 812, 1 927) sont des exemples. Les vrais viennent de `/v1/rob/stats` ; ajouter une ligne dans `CLAIMS.md`.

## Ce qui n'est pas dans le périmètre de cette PR

- Le classement, les trophées $LEASH, Rug O'Clock et la carte à partager sont dessinés mais viennent **après** les cartes I à IX, Hire him et Fork Ruggy's law. Ordre conseillé : cartes I à IX → Hire him → wallet à la fin et Fork → contre-offre → Look Legit et Inside Job → Rug O'Clock → endpoints juges et README.
- Vocabulaire : dire « council », pas « guardians » (le mot est réservé à la récupération, post-hackathon, non codée).

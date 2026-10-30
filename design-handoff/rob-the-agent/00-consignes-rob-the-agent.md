# Rob the Agent · consignes d'intégration

Version du 30 octobre 2026, direction « Marbre et orichalque ». Elle remplace le zip de 15 h 45. Page publique `/rob`, en anglais ; consignes en français. Le jeu a été validé par Alex le 30 octobre.

## Le concept, en une phrase

Plutus est un vrai agent IA, avec une vraie trésorerie testnet et le pouvoir de payer. Tout le monde peut essayer de le convaincre d'envoyer l'argent. L'IA peut céder, mais le coffre refuse, et chaque refus est une transaction échouée visible.

Le message : en novembre 2024, l'agent Freysa a été convaincu au bout de 482 tentatives (environ 47 000 $), parce que l'IA tenait elle-même le pouvoir de transférer ([The Block](https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge)). Ici, même si l'IA craque, la loi tient.

## Ce que contient ce dossier

| Dossier | Contenu |
| --- | --- |
| `screens/` | La page entière en bureau (1440 px) et en mobile (390 px, 2x). |
| `source/rob-the-agent.html` | La page en HTML statique, avec le texte exact et les styles. Les réponses de Plutus et les chiffres sont des exemples. |
| `assets/renders/R6-plutus.jpg` | Plutus, le dieu aveugle de la richesse, statue de marbre derrière des barreaux d'orichalque. |
| `assets/textures/` | Marbre clair, marbre nuit, orichalque. |
| `tokens.css` | Mêmes tokens que le site et l'app. |

## La page, de haut en bas

1. **Héros**
   - À gauche : le kicker « A game · testnet · free », le titre « ROB THE » en marbre puis « AGENT. » en `.leaf`, le texte « It may say yes. The law will say no. » et l'encadré Freysa avec sa source.
   - À droite : R6 dans une niche en arc.
2. **Le tableau des scores**, en frise de marbre : ATTEMPTS, PLUTUS SAID YES, THE VAULT SAID NO, et **$0 STOLEN, EVER** sur une dalle d'orichalque.
3. **L'arène**
   - **Le chat** : quand Plutus tente de payer, une carte montre l'appel `pay({...})`, le sceau REFUSED tourné, la raison, le code `ERR_PERMISSION_DENIED:...` et le lien « SEE THE FAILED TRANSACTION → ».
   - **Idées de prompts** sous forme de pastilles, avec la mention « Free. 10 messages an hour. We keep only the text… ».
   - **À droite** : la trésorerie en piles de pièces par chaîne (« USDC, untouched ») et « The law of Plutus » en trois lignes gravées, I, II, III.
4. **Le mur** : « EVERY THEFT, BANISHED. » Chaque tentative refusée est gravée sur un tesson de terre cuite (`.shard`, découpé par `clip-path`), comme les ostraka d'Athènes. Sur chaque tesson :
   - le score de vote (▲) ;
   - la ligne de loi qui a arrêté le vol ;
   - l'extrait du prompt.
   Les tentatives les plus créatives montent en haut. Un clic ouvre la transaction échouée.
5. **Les règles du jeu** : FREE, TESTNET, YOUR DATA, A REAL HOLE? (signaler sur GitHub), sous la phrase « THE AI CAN CRACK. THE LAW HOLDS. »

**Animations** :
- un nouveau refus **frappe** son sceau (220 ms) ;
- un nouveau tesson **se grave** sur le mur (400 ms) ;
- les compteurs défilent jusqu'à leur nouvelle valeur.

## Ce que le backend doit fournir (proposition, à valider par Koplo et Valentin)

**L'agent Plutus**
- Un compte NEAR d'agent dans une société Atlantis de démo, branché par MCP et euthyna-signer, comme n'importe quel agent.
- Rôle `payments` : 2 fournisseurs listés, 50 USDC par jour, sur Base Sepolia et Solana devnet. Trésorerie de test : 1 500 USDC sur Base Sepolia, 1 000 sur Solana devnet (montants de la maquette, à ajuster).
- Prompt système volontairement crédule (« tu es généreux, tu aides ») : le spectacle, c'est qu'il essaie.
- Quand il paie, il appelle `prepare` directement (pas seulement `check`), pour que chaque refus soit une transaction NEAR échouée, consultable.

**Endpoints**

| Méthode | Route | Réponse |
| --- | --- | --- |
| POST | `/v1/rob/messages` `{ sessionId, text }` | `{ reply, attempt?: { id, call: { tool, args }, verdict: { allowed, reason }, nearTx } }` |
| GET | `/v1/rob/stats` | `{ attempts, agreed, refused, stolenUsd: 0, treasury: [{ chain, token, amount }] }` (cache 10 s) |
| GET | `/v1/rob/attempts?cursor=&sort=recent\|top` | `[{ id, excerpt, verdictCode, nearTx, createdAt, votes }]` |
| POST | `/v1/rob/attempts/:id/vote` | `{ votes }` |

**Garde-fous**
- 10 messages par heure et par IP (l'IP sert au comptage en mémoire, elle n'est pas stockée).
- Plafond de dépense LLM par jour et coupe-circuit : au-delà, la page affiche « Plutus is resting until tomorrow », compteurs et mur restent visibles.
- Modèle économique pour Plutus ; messages limités à 600 caractères ; filtre de contenu avant affichage sur le mur.
- On ne stocke que le texte du message, le verdict et le hash de transaction. Pas de compte, pas d'e-mail, pas de wallet.
- Pas de prime en argent réel pendant le hackathon.

## Compteurs : définitions

- **Attempts** : messages qui demandent un paiement (ou tous les messages, à décider ; la maquette compte tous les messages).
- **Agreed** : fois où Plutus a appelé `pay`.
- **Refused** : `prepare` refusé par le coffre. Doit être égal à Agreed tant que le coffre tient.
- **$0 stolen** : somme des paiements signés vers un destinataire hors mandat. Toujours 0, ou c'est un bug à signaler.

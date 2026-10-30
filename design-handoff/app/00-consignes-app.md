# EUTHYNA · App (la console d'une société Atlantis) · consignes d'intégration

Version du 30 octobre 2026, direction « Marbre et orichalque » (validée par Alex). Elle remplace le zip de l'app de 15 h 45. Interface en anglais ; consignes en français. À donner tel quel à l'IA qui code.

## Ce que contient ce dossier

| Dossier | Contenu |
| --- | --- |
| `screens/` | Seize écrans en bureau (1440 × 1040, 2x) et deux en mobile (390 px, 2x). |
| `source/*.html` | Chaque écran en HTML statique, avec le texte exact et les styles. C'est la référence visuelle ; les données sont des exemples. |
| `assets/renders/` | Les statues des agents : R2 Naomi, R2B Thetis, R2C Hermes. Aussi R3 (Atlantis, pour la fondation), R7 (sceau réparé, pour la récupération) et R8 (colonne, pour la connexion). |
| `assets/textures/` | Marbre clair, marbre nuit, orichalque. |
| `tokens.css` | Couleurs, polices, ombres, durées. Mêmes valeurs que le site. |

## Deux produits, deux parcours (décidé le 30 octobre avec Alex et Valentin)

EUTHYNA, c'est ce qu'on vend : l'infrastructure. Atlantis est un produit construit avec EUTHYNA, le launchpad. Le backend est le même ; seul l'onboarding diffère.

| Parcours | Pour qui | Étapes de l'onboarding | Ce qui est sauté |
| --- | --- | --- | --- |
| **Use EUTHYNA** (« Create your vault ») | Une équipe ou un dev qui a déjà son agent | Team, Members, Incorporate, Wallet, First hire, Role, **Plug in** (`RunYourAgent`) | Shares, et l'inscription dans l'annuaire public |
| **Launch on Atlantis** (« Found a company ») | Un fondateur qui part de zéro | Company, Founders, Incorporate, Wallet, Shares, First hire, Role, **City** (proposition d'inscription dans l'annuaire, le vote de `DirectoryCard`) | Rien |

- Juste après la connexion, quand le membre n'a encore aucune société, l'écran 16 lui fait choisir son parcours. On peut le passer en paramètre, par exemple `/onboarding?path=euthyna` ou `?path=atlantis`, pour que les boutons du site y mènent directement.
- **Le parcours EUTHYNA reste privé** : pas de parts, pas d'annuaire. Rejoindre Atlantis plus tard se fait depuis l'app, avec deux votes : émettre des parts (`/shares`) et s'inscrire dans l'annuaire (Settings, `DirectoryCard`). Aucune migration n'est nécessaire.
- **Le choix doit être mémorisé** : l'étape « Shares » est marquée « skipped » pour un coffre EUTHYNA, ce que `SetupProgress` sait déjà faire.

## Le principe

Une société, c'est une DAO (les membres qui votent), un coffre sans clé et des agents IA. Chaque écran dit trois choses :
1. **Qui peut faire quoi** : chaque agent a un rôle voté, écrit en lignes I, II, III…
2. **Ce qui s'est passé** : chaque demande reçoit un **sceau** du coffre (SIGNED, REFUSED, PENDING, SETTLED, HELD, EXPIRED…) et sa raison.
3. **Qui décide** : les votes en attente sont toujours visibles, et le conseil de sécurité a son bouton d'arrêt dans la barre latérale.

**Mise en page** :
- une barre latérale nuit : la société, la navigation en chiffres romains I à IX, le bloc du conseil, l'utilisateur ;
- un sol de marbre clair, avec des **dalles** pour les cartes (`.slab`) ;
- des **panneaux nuit** pour ce qui juge : les verdicts, le veto, un achat, une proposition à voter ;
- l'**orichalque** pour l'action principale, les totaux et la carte de dépense.

Les titres de page sont gravés (`.carved`, Cinzel 900, en capitales). Les montants, comptes et hashes sont en JetBrains Mono.

**Les agents sont des statues** dans une niche en arc, une statue par type de rôle :
- `payments` : R2 (Naomi) ;
- `treasury` : R2B (Thetis, la balance) ;
- `revenue` : R2C (Hermes, la pièce) ;
- rôle écrit à la main : niche nuit avec l'initiale de l'agent.

Un agent au repos est un peu désaturé.

## Écrans, routes et données

Toutes les routes et sources citées existent sur `main` (commit 93f1ec4). Il faut les brancher, pas les réinventer.

| # | Écran | Route | Ce qu'on voit | Données sur main |
| --- | --- | --- | --- | --- |
| 00 | Sign in | `SignIn.tsx` | À gauche la colonne R8 et la phrase « AI agents move company funds. Humans set the limits. » avec 3 lignes. À droite : « SIGN IN », le portefeuille connecté et son lien Change, le bouton orichalque, et la phrase pour les nouveaux membres. | `connectNearWallet`, `nearAccounts`, `/api/auth/near/challenge`, `/api/auth/sign-in/near` |
| 01 | HQ | `/overview` | Trésorerie en colonnes cannelées par chaîne, votes en attente avec compte à rebours, agents dans leurs niches avec jauges de budget, fil des verdicts. | holdings, `activity` (integrity), governance, roles, market |
| 02 | Mandat d'un agent | `/roles` (+ `/agents`) | Statue, fiche (clé, MCP, embauche, compte), la phrase du mandat avec les valeurs soulignées en or, lignes I à V, budgets en colonnes, « Ask the vault » (vérification gratuite, rien n'est signé), derniers verdicts. | roles, `check_operation` (vue du coffre), activity |
| 03 | Activity | `/activity` | Bandeau d'intégrité (sceau INTACT, « Every transaction went through the vault »), filtres All / Done / In progress / Refused avec compteurs, jours, une ligne par opération avec son sceau, preuve dépliée. Un refus a le bouton « Ask the members to vote on it ». | `omni.activity` (+ `integrity`), `marketConsole.sales`/`purchases`, `Trust`, `Proof`, `MarketProof`, `AskMembers` |
| 04 | Treasury | `/wallet` | Total en orichalque avec une colonne par chaîne ; les adresses (Base et Ethereum partagent une adresse ; Solana ; NEAR) et Copy ; « Connect an app » (WalletConnect) avec une demande d'app ; « Members will vote on » (aperçu vérifié, caution de 0,1 NEAR) ; transactions votées. | `status` (address, solana, chains), WalletConnect, `prepare`/`TransactionBuilder`, governance.transactions |
| 05 | Votes | `/governance` | Propositions en attente, avec des jetons de vote en bronze (oui) ou vides, lignes I, II, III, la mention « Read in your browser… », Reject et Approve. Panneau nuit « Approved · veto window » avec un anneau du temps restant et VETO. Membres, historique, Emergency, et la frise « How a proposal becomes law ». | governance (proposals, rules, transactions), `signDaoAction`, `veto_operation`, `pauseProposal` |
| 06 | Market | `/selling` | Revenus, ventes, achats ; les « stalls » (annonces : LIVE, DRAFT, jeton du worker) ; ventes avec sceau d'état ; achats des agents ; **un achat raconté sceau par sceau** (refusé au-dessus de max_price → demandé → chèque retenu → livré → payé à la livraison, avec le hash) ; la **carte de dépense** de l'agent en orichalque. | `marketConsole.listings`/`sales`/`purchases`, `PAYMENT_TEXT` (held, settling, settled, prepaid, failed, expired) |
| 07 | Fonder une société | `/onboarding` | Plein écran nuit, avec Atlantis (R3) derrière. C'est le parcours long « Launch on Atlantis ». Étapes I à VIII (Company, Founders, Incorporate, Wallet, Shares, First hire, Role, City) en sceaux. Étape « First hire » : trois rôles en niches avec statue, ce que chacun permet, puis « Next · VII · Role » et le bouton orichalque. | `STEPS`, `JOBS` (`lib/jobs.ts` : payments, treasury, revenue), `NewAgent` |
| 08 | Agents | `/agents` | Une carte par agent : statue, nom, compte, rôle, état (working, idle, paused), « done on chain » et « refused », dernière action, jauges de budget avec « new budget » et Propose, « Give it another role », « Fire by vote ». Un agent embauché sans rôle (« waiting for a role ») et l'encadré « How hiring works ». | `/v1/console/agents`, roles, activity, `fireProposal`, `membershipProposal`, `budgetProposal`, `NewAgent`, `RunYourAgent` |
| 09 | Owners | `/shares` | Bandeau d'orichalque des parts (prix, vendues, verrouillées pour voter, revenus partagés). Qui possède la société : la frise locked, free et unsold, plus les 3 vérifications. Mes parts (held, locked, free, to claim) avec Lock to vote et Claim. Buy. L'époque en cours dans un anneau, avec Prove my vote. Share revenue. Send proceeds. | `SharesDashboard` (`info`, `holder`, `lockedTotal`, `keyless`, `votesCounted`, `shareholdersVote`), `buy`, `lock`, `claim`, `prove_vote`, `revenueProposal` |
| 10 | Settings | `/settings` | Security : DAO et vault, puis « 8 of 8 on-chain checks pass » ligne par ligne. Vault version, avec une version plus récente en fenêtre de veto. Liens Company, Shares, Suppliers. Public directory. **Recover your access, PLANNED** : 4 facteurs en pointillés, sans bouton actif. | `status.checks` (`TreasuryChecks`), `VersionCard`, `DirectoryCard` ; la récupération n'a pas de code |
| 11 | HQ en pause | `/overview` quand `status.paused` | Bandeau terre cuite « Operations are paused… » avec Propose to resume, les agents « paused » (statues grisées), le bloc du conseil en « Agents halted ». | `status.paused`, `pauseProposal(false)` |
| 12-13 | Mobile | — | HQ et Activity en 390 px : barre du haut nuit, navigation en pastilles qui défilent, sections empilées, barre du conseil « HALT ALL » en bas. | mêmes données |
| 14 | Rules | `/roles` | À gauche, les rôles en vigueur comme des tablettes : nom, agent, budgets avec le reste disponible, et « Allowed » en lignes I, II, III avec leurs sous-conditions. À droite, le constructeur « New role » : nom, cases « Require Guard approval » et « Recipient must be a supplier », blocs ajoutés (ici Aave V3 et WETH) avec leurs champs, boutons + Transfers, + Solana transfers, + Pay in NEAR tokens, + DeFi…, et le catalogue DeFi (WETH, Uniswap V3, Uniswap V2, Aave V3). Dessous, le panneau nuit « Members will vote on » avec la vérification et la caution. | `roles`, `roleProposal`, `DEFI_CATALOG`, blocs de `RolesPage.tsx` |
| 15 | Suppliers | `/suppliers` | La liste des fournisseurs gravée sur une stèle (nom, adresse, proposition qui l'a votée). « Add supplier », « Pending changes », et l'encadré qui relie la liste au refus de 0x9f3…e21. | `suppliers` (entries), proposals en attente, `request.mutate` |
| 16 | Choisir son parcours | après la connexion, sans société | Deux portes en arc. **EUTHYNA**, en marbre avec la porte du coffre (R4) : « Give your agent a wallet with rules », 3 lignes, puis « Private: no shares, not listed », bouton CREATE YOUR VAULT. **ATLANTIS**, en nuit avec la cité (R3) : « Start a company whose employees are AI agents », 4 lignes, bouton FOUND A COMPANY. Phrase du haut : « Same vault, same rules underneath. You can join Atlantis later. » | aucune donnée ; écrit le parcours choisi |
| 17 | Parcours EUTHYNA · Plug in | fin de `/onboarding?path=euthyna` | Étapes I à VII en sceaux (la dernière, Plug in, en cours). « Plug it into your AI » : la commande `claude mcp add …` et l'onglet JSON. Le paquet npm reste étiqueté NEXT tant qu'il n'est pas publié. Ensuite : « What you now have », « Private by default » avec Join Atlantis later, la statue de l'agent, et les 3 prochaines étapes (vote, veto, Activity). | `RunWithSigner` (`MCP_PACKAGE`, `EUTHYNA_AGENT`), treasury, governance |

Tous les écrans de la console sont dessinés. Un écran nouveau suit les mêmes composants : dalles, panneaux nuit, sceaux, colonnes.

## Composants à créer une fois

- `Seal` : un disque de bronze avec un mot (SIGNED, REFUSED, PENDING, SETTLED, HELD, SETTLING, EXPIRED, APPLIED, VETOED, INTACT…). Le refus est tourné de −8° et teinté terre cuite. Tailles : 32, 38, 44, 52 et 80 px.
- `Slab` : une carte de marbre.
- `NightPanel` : un panneau nuit.
- `Kicker` : Cinzel 11 px, en capitales, espacement de 0,26 em.
- `Niche` : une statue dans un arc.
- `ColumnGauge` : une colonne cannelée, remplie selon la valeur, pour les budgets et les avoirs.
- `VoteTokens` : des jetons de bronze, un par vote.
- `VetoRing` : un anneau orichalque qui montre le temps restant.
- `SpendingCard` : la carte d'orichalque de l'agent.

## États à couvrir

- **Vide** : « No proposal is waiting for votes », « Nothing here yet », « No listing yet. Create one, run its worker, then put it live ».
- **Chargement** : les dalles en gris pâle, jamais un écran blanc.
- **Erreur** : une phrase, puis quoi faire ; rien n'est signé.
- **Pause** : écran 11.
- **Signature** : le navigateur relit la proposition avant de signer, comme c'est déjà le cas sur main. Le toast le dit.

## Mobile

Voir les écrans 12 et 13.

- La barre latérale devient une rangée de navigation qui défile.
- Les grilles passent sur une colonne.
- Les panneaux prennent toute la largeur.
- Les lignes du fil se réduisent au sceau et au texte.
- Aucune barre horizontale.

## Vocabulaire

- Agent, jamais « bot ».
- Members ou Owners : ceux qui votent.
- Security council, Role ou Mandate, Vault.
- Verdicts : Signed, Refused, Co-sign, Voted.
- Market : spending card, a held cheque, paid on delivery.
- « Testnet » partout.
- NEAR apparaît comme chaîne et comme compte (« Paid on NEAR », « vault.….testnet »), jamais comme marque.

## Non construit, à afficher PLANNED

- La récupération d'accès : passkey, ZKPassport, ZK Email, contact de confiance.
- Les chaînes Bitcoin, Tron, Arbitrum, BSC et Plasma.

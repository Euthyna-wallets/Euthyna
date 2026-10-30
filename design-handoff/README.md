# EUTHYNA · design handoff (direction « Marbre et orichalque »)

Version du 30 octobre 2026. Écrit pour Valentin et pour l'IA qui code. Interface en anglais, consignes en français.

> **Cette branche (`design/handoff`) ne se fusionne jamais.** Elle sert de référence de design. On copie dans `main` uniquement ce qui est utile (images, matières, vidéo) et on code les écrans dans une branche de travail habituelle.

## 1. Par où commencer

À lire dans cet ordre :

1. **Ce README** : la décision produit et les règles.
2. `brand/00-consignes-marque.md` : la direction artistique, puis `brand/direction/direction.png` pour la voir.
3. `site/00-consignes-site.md`, puis les écrans `site/screens/`.
4. `app/00-consignes-app.md`, puis les écrans `app/screens/`. Ce fichier contient le tableau écran par écran : route sur main, ce qu'on voit, d'où viennent les données.
5. `rob-the-agent/00-consignes-rob-the-agent.md`, à faire en dernier.

Tous les dossiers ont la même forme :

| Dossier | Contenu |
| --- | --- |
| `00-consignes-*.md` | Ce qu'il faut construire, avec les routes et les données de main. |
| `screens/*.png` | La référence visuelle, à respecter au pixel près autant que possible. |
| `source/*.html` | Chaque écran en HTML statique. Il s'ouvre dans un navigateur, et on y trouve le texte exact, les couleurs et les styles (dans le `<style>` en tête). **Les données sont des exemples.** |
| `assets/` | Les images utilisées par ces écrans (rendus photo, matières, vidéo). |
| `tokens.css` | Les variables de couleurs, polices, ombres et durées, identiques partout. |

Le canevas de design complet (toutes les planches côte à côte) : https://claude.ai/artifact/F8D8pMuUBrbkmpCvZNnJze

## 2. La décision produit : deux portes, un même moteur

- **EUTHYNA, c'est ce qu'on vend : l'infrastructure.** Un agent IA reçoit un wallet avec un budget et des règles votées, jamais une clé. Le coffre vérifie chaque transaction avant de signer.
- **ATLANTIS est un produit construit avec EUTHYNA : le launchpad.** On y crée une société dont les employés sont des agents, avec des parts, des revenus et le Market. C'est aussi notre meilleure démo.

Le backend est le même. **Seul l'onboarding diffère** :

| Parcours | Bouton | Étapes | Sauté |
| --- | --- | --- | --- |
| Use EUTHYNA | PLUG IN YOUR AGENT / CREATE YOUR VAULT | Team, Members, Incorporate, Wallet, First hire, Role, Plug in | Shares et inscription dans l'annuaire : le coffre reste privé |
| Launch on Atlantis | START A COMPANY ON ATLANTIS / FOUND A COMPANY | Company, Founders, Incorporate, Wallet, Shares, First hire, Role, City | Rien |

- **Le choix** se fait sur l'écran `app/screens/16-choose-your-path-desktop.png`, juste après la connexion. Il peut aussi passer en paramètre : `/onboarding?path=euthyna` ou `?path=atlantis`, depuis les boutons du site.
- **Un coffre EUTHYNA peut rejoindre Atlantis plus tard** par deux votes : émettre des parts (`/shares`) et s'inscrire dans l'annuaire (`DirectoryCard`). Aucune migration n'est nécessaire.

## 3. Ce qu'on copie dans `main`, et où

| Depuis cette branche | Vers (proposition) | Usage |
| --- | --- | --- |
| `site/assets/video/hero-loop.mp4` et `hero-poster.jpg` | `apps/console/public/media/` | Fond du héros du site, muet et en boucle. Avec `prefers-reduced-motion`, afficher le poster. |
| `brand/assets/renders/*.jpg` | `apps/console/public/media/renders/` | Les rendus photo : stèle, statues des agents, Atlantis, coffre, clé, sceau, colonne, Plutus. |
| `brand/assets/textures/*.jpg` | `apps/console/public/media/textures/` | Les matières de fond : marbre clair, marbre nuit, orichalque, bronze. |
| `brand/tokens.css` | `apps/console/src/styles/` (ou le fichier de thème existant) | Les variables. |
| `brand/logo/*.svg` | là où sont les logos actuels | Inchangés. |

Les sources HTML ne se copient pas telles quelles. Elles servent de référence pour coder les composants React. La console existe déjà sur main : on garde sa logique (routes, requêtes, signatures) et on change le rendu.

## 4. Correspondance rapide écran → route sur main

| Écran (`app/screens/`) | Route | Fichier sur main |
| --- | --- | --- |
| 00 sign-in | connexion | `routes/SignIn.tsx` |
| 16 choose-your-path | après connexion, sans société | nouveau |
| 17 euthyna-path-plug-in | fin de l'onboarding EUTHYNA | `routes/OnboardingPage.tsx` + `AgentSetup.tsx` (`RunWithSigner`) |
| 07 atlantis-found-a-company | `/onboarding` (parcours Atlantis) | `routes/OnboardingPage.tsx`, `lib/jobs.ts` |
| 01 hq · 11 hq-paused | `/overview` | `routes/OverviewPage.tsx` |
| 08 agents | `/agents` | `routes/AgentsPage.tsx` |
| 02 agent-mandate · 14 rules | `/roles` | `routes/RolesPage.tsx` |
| 03 activity | `/activity` | `routes/ActivityPage.tsx` |
| 04 treasury | `/wallet` | `routes/WalletPage.tsx` |
| 05 votes | `/governance` | `routes/GovernancePage.tsx` |
| 09 owners-shares | `/shares` | `routes/SharesPage.tsx` |
| 06 market | `/selling` | `routes/MarketConsolePage.tsx` |
| 10 settings-recovery-planned | `/settings` | `routes/SettingsPage.tsx` |
| 15 suppliers | `/suppliers` | `routes/SuppliersPage.tsx` |
| 12 hq-mobile · 13 activity-mobile | toutes, en 390 px | — |

Pour le site public, voir `site/00-consignes-site.md`. Le React actuel est sur la branche `design/atlantis-site` (`apps/console/src/routes/public/atlantis/`) : la structure et les textes sont bons, il faut lui appliquer le nouveau style.

## 5. Règles à ne pas casser

- **Testnet uniquement.** Les juges (dont Claude Code et Codex) comparent chaque affirmation au repo. Rien n'est affiché comme fait si le code ne le fait pas.
- **Chaque affirmation du site a sa ligne dans `CLAIMS.md`.**
- **Chaînes** :
  - Base Sepolia est prouvé.
  - Ethereum Sepolia et Solana devnet sont « Reported » tant que leurs hashes ne sont pas dans `docs/`.
  - Arbitrum, BSC, Plasma, Tron et Bitcoin sont PLANNED.
  - Ne jamais écrire « every chain » ni « all chains ».
- **Étiquettes obligatoires** :
  - la récupération d'accès (passkey, ZKPassport, ZK Email, contact de confiance) est **PLANNED** : il n'y a pas de code ;
  - `@euthyna/mcp` sur npm reste **NEXT** tant qu'il n'est pas publié.
- **NEAR au second plan sur le site** (pas dans le héros). Dans l'app, les libellés techniques comme « Paid on NEAR » restent.
- **Interdits** : aucune mention de JOIN, aucun concurrent nommé.
- **Données d'exemple** : Pixel Forge, Naomi, Thetis, Hermes, les montants et les hashes des maquettes sont des exemples. À l'écran, on affiche les vraies données de l'API. Seul le hash `7FSbXRBN…LJvXv` du Market vient du vrai test de bout en bout.

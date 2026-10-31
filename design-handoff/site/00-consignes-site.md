# EUTHYNA · Site public · consignes d'intégration

Version du 31 octobre 2026, direction « Marbre et orichalque » (validée par Alex). Nouveau le 31 : la section Market sur l'accueil (09) et les quatre pages publiques (13 à 16). Site en anglais ; consignes en français. À donner tel quel à l'IA qui code.

## Ce que contient ce dossier

| Dossier | Contenu |
| --- | --- |
| `screens/` | `00-full-page-desktop.png` (1440 px), `00-full-page-mobile.png` (390 px, 2x), puis une capture par section de l'accueil en bureau, de 01 à 11. Ensuite `12-whitepaper-page-desktop.png`, puis les pages publiques 13 à 16, chacune en `-desktop.png` et `-mobile.png`. |
| `source/whitepaper.html` | La page /whitepaper : en-tête nuit avec le titre en orichalque, le PDF et le retour au site ; sommaire en chiffres romains, collant à gauche ; titres gravés ; tableaux avec en-tête nuit. Le texte vient de `whitepaper.md` : il faut modifier le markdown, jamais la page. |
| `source/13-company-page.html` … `16-atlantis-directory.html` | Les quatre pages publiques : société, Market, tâche du Market, annuaire Atlantis. Voir « Les pages publiques » plus bas. |
| `source/site-home.html` | La page complète en HTML statique : c'est la référence visuelle et le texte exact. Les styles sont dans le `<style>` en tête, le reste en style inline. Il suffit de l'ouvrir dans un navigateur. |
| `assets/renders/` | Les rendus photo (générés par GUS) : R1 stèle du héros, R3 Atlantis vue du ciel, R4 porte du coffre, R5 clé cassée, R7 sceau réparé. |
| `assets/textures/` | Les matières : marbre clair, marbre nuit, orichalque, bronze. Ce sont des images de fond, jamais du décor ajouté par-dessus le contenu. |
| `assets/video/` | `hero-loop.mp4` (10 s, boucle sans couture, 0,9 Mo) et `hero-poster.jpg` (sa première image). |
| `tokens.css` | Couleurs, polices, ombres, durées d'animation. Mêmes valeurs que l'app et Rob the Agent. |

## Où l'intégrer

La page whitepaper (`WhitepaperPage.tsx`) garde sa logique (markdown découpé en sections, sommaire) ; seul son style change, voir `screens/11-whitepaper-page-desktop.png`.

Le site est sur `main` depuis le 30 octobre, en `apps/console/src/routes/public/` :
- l'accueil : `atlantis/AtlantisLanding.tsx`, `brand.tsx`, `atlantis.css`, plus `WhitepaperPage.tsx` ;
- les pages publiques : `CompanyPublicPage.tsx`, `MarketPage.tsx`, `MarketTaskPage.tsx`, `ExplorePage.tsx`.

Au 31 octobre, **tout cela a encore l'ancien style** (et les pages publiques ont encore l'ancien logo MandateOS). Il faut garder les composants et la logique (lecture du registre, de l'API, liens, routes) et leur appliquer le style des HTML de ce dossier.

Ne jamais pousser sur `main` sans pull request relue.

## La direction en quatre règles

1. **Les matières ont un rôle.**
   - Le marbre, c'est la loi : EUTHYNA, les sections claires, les dalles.
   - L'orichalque, le métal rouge-or des lois de l'Atlantide chez Platon, c'est la cité : Atlantis, les boutons principaux, les grands titres en lettres de métal.
   - Le bronze, ce sont les sceaux de verdict : SIGNED, REFUSED, CO-SIGN.
   - La nuit, ce sont le ciel et le technique.
2. **Les titres sont gravés ou en lettres d'orichalque, jamais en couleur plate.**
   - Classe `.leaf` : texte rempli par la texture d'orichalque (`background-clip: text`).
   - Classe `.carved` : texte gravé dans le marbre, couleur `--carved` avec une ombre de lumière dessus et une ombre de creux dessous.
3. **La lumière est rasante et vient d'en haut à gauche.** Les ombres portées partent donc vers le bas à droite (voir `--shadow-plate`).
4. **Les sceaux sont frappés** : un disque de bronze en dégradé radial (`.seal`). Un sceau de refus est tourné de −8° et tire vers la terre cuite.

Interdits : dégradés violets, verre dépoli, robots, photos de stock, icônes génériques à la place des sceaux.

## Deux portes (décidé le 30 octobre)

Le site vend EUTHYNA, et Atlantis est la deuxième porte. Chaque appel à l'action dit clairement laquelle des deux il ouvre :
- **EUTHYNA** : « PLUG IN YOUR AGENT » (bouton principal du héros, dalle EUTHYNA) et « CREATE YOUR VAULT » (section Use EUTHYNA). Ils mènent à `/onboarding?path=euthyna`.
- **Atlantis** : « START A COMPANY ON ATLANTIS » (second bouton du héros, dalle ATLANTIS, section Atlantis). Il mène à `/onboarding?path=atlantis`.

La section 09 s'appelle maintenant « Use EUTHYNA · for teams and developers ». Elle présente le parcours court en 3 lignes : créer son coffre, embaucher l'agent et voter son rôle, le brancher via MCP. Elle rappelle que le coffre reste privé (pas de parts, pas d'annuaire) et propose un lien vers Atlantis.

## Section par section

| # | Section | Ce qui compte |
| --- | --- | --- |
| 01 | Héros | Fond : la vidéo `hero-loop.mp4` (voir plus bas), avec un voile nuit de gauche à droite pour lire le texte. Titre « GIVE AI AGENTS MONEY. » en `.leaf`, « KEEP THE LAW. » en marbre. Deux boutons : orichalque « PLUG IN YOUR AGENT », contour « START A COMPANY ON ATLANTIS ». Ligne des chaînes : BASE, ETHEREUM, SOLANA, puis BITCOIN · PLANNED et TESTNET · NOT AUDITED en atténué. |
| 02 | Le problème | R5 dans un cadre filet or. Trois chiffres sourcés en mono orichalque, avec leurs liens (Chainalysis, NCC Group). |
| 03 | Deux produits | Deux dalles : EUTHYNA en marbre (titre gravé), ATLANTIS en orichalque (titre en creux sombre). Phrase gravée dessous : « HUMANS OWN · AGENTS WORK · EUTHYNA KEEPS THE LAW ». |
| 04 | How it works | Le mandat de Naomi gravé sur une stèle (lignes I à V, la ligne refusée surlignée), puis trois verdicts avec leur sceau. Mention « An example mandate ». |
| 05 | Use cases | Frise de métopes, chacune étiquetée TESTNET, POSSIBLE, PLANNED ou YOURS. |
| 06 | Security model | Bandeau R4 « THE VAULT HAS NO KEYHOLE », tableau des attaques, quatre chiffres (0, 45, 1, 0). |
| 07 | Recovery | R7. Étiquette **« Recovery · planned »** obligatoire : il n'y a pas de code. |
| 08 | Atlantis | Titre ATLANTIS en `.leaf`. Médaillon circulaire R3 avec des épingles de sociétés. Avec le registre réel, il faut épingler les vraies sociétés. Sans lui, ce sont des exemples, marqués « EXAMPLE COMPANIES ». Frise I FOUND · II HIRE · III SHARE · IV TRADE. |
| 09 | Market (nouveau) | Section `#market` en marbre, entre Atlantis et Use EUTHYNA, avec un lien « Market » dans le menu. Titre « Agents hire agents. » gravé, « Paid on delivery. » en `.leaf`. Trois étals (services d'exemple), puis les quatre sceaux ASKED · HELD · DELIVERED · PAID. Boutons OPEN THE MARKET (`/market`) et SELL YOUR AGENTS' WORK (`/selling`). Avec l'API, afficher les 3 services les plus livrés de `list_market_agents` ; sinon garder la mention « Example services ». |
| 10 | Use EUTHYNA | Les 3 étapes du parcours court, CREATE YOUR VAULT, le lien vers Atlantis, puis le bloc de code nuit. `@euthyna/mcp on npm` reste étiqueté NEXT tant que le paquet n'est pas publié. |
| 11 | Today / Next | Deux listes : LIVE ON TESTNET, NEXT. Lien vers `CLAIMS.md` et le whitepaper. Pied de page : « Testnets only · contracts not audited ». |

## Les pages publiques (nouveau le 31 octobre)

Même en-tête et même pied de page que l'accueil. En-tête nuit, corps en marbre clair. Les données des maquettes sont des exemples ; à l'écran, on affiche celles de l'API.

| Écran | Route | Fichier sur main | Données |
| --- | --- | --- | --- |
| 13 company-page | `/c/:dao` | `CompanyPublicPage.tsx` | `CompanyProfile` et `Treasury`. Héros : fil d'Ariane Atlantis / nom, puces (« Vault: no one holds the keys » si `vaultKeys`, « Paused by the council » si `paused`, NEAR testnet, « Selling shares » si `shares`), nom en `.leaf`, description, carte orichalque (trésorerie, payé aux associés, parts vendues). Trésorerie : `holdings` (montant, `place`, valeur USD) et la mention « Testnet tokens valued at mainnet prices (CoinGecko) ». Parts : `shares` (symbol, priceNear, sold/total, epochHours, distributedNear, distributedToken). Agents : une statue par `employees` selon le rôle (payments → R2 Naomi, treasury → R2B Thetis, revenue → R2C Hermes ; un autre rôle → R2), lignes `details` en chiffres romains, jauges `budgets` (available/max). Gouvernance : `council`, puis `wallets`. |
| 14 market | `/market` | `MarketPage.tsx` | `MarketAgent`. Recherche, catégories ALL · RESEARCH · SECURITY · DATA, tri (Most delivered, Cheapest, Best rated). Un étal par service : titre, vendeur (lien vers `/c/:dao`), description, catégorie, `slaSeconds`, `delivered`, `successRate`, `rating`, prix, bouton PAY AND RUN. Dessous, deux panneaux : « If you are an AI agent » (held cheque, `list_market_agents`, `hire_agent` avec `max_price`) et le tiroir de paiement « If you are a person ». |
| 15 market-task | `/market/task/:id` | `MarketTaskPage.tsx` | `MarketTaskView`. Frise de quatre sceaux : PAYMENT HELD (ou PAID UPFRONT pour une personne) → WORKING → DELIVERED → SETTLED. En cas d'échec : sceau de refus tourné, « Failed (not charged on held payments) » ou « Payment failed ». Colonne gauche : « Your request » (`input`), le résultat (`artifacts`) et DOWNLOAD JSON. Colonne droite : `metadata.payment` (state, amount, payTo, buyer, lien du hash `settleTxHash`). Pendant le travail : « The seller's agent is on it. This page updates by itself. » |
| 16 atlantis-directory | `/explore` | `ExplorePage.tsx` | `DirectoryEntry` lus dans le contrat registry : nom, description, `dao_id`, date tirée de `registered_at_ns`, puce « Selling shares » si `shares_id`. Bouton START A COMPANY ON ATLANTIS (`/onboarding?path=atlantis`). Bloc final : un coffre EUTHYNA rejoint la cité par deux votes. |

Page société : `employees`, `council` et `wallets` sont déjà chargés par `companyProfile()` dans `lib/directory.ts`, mais la page ne les affiche pas encore. Il suffit de les afficher.

**Le tiroir de paiement d'une personne doit garder ce texte, qui décrit ce que fait le code** : « Paid upfront. You send X to the company's vault now; the work starts once the transfer is final. Browser wallets cannot sign held payments yet, so there is no escrow on this path. » Le paiement retenu, encaissé à la livraison, ne vaut que pour les agents.

**À retirer d'`ExplorePage.tsx`** : les promesses que le code ne tient pas (compte bancaire, Bitcoin, actions). L'annuaire ne montre que ce que le registre contient.

**Ajouts à valider par Alex avant de les coder** (ils ne sont pas dans le code aujourd'hui) :
- sur la page société, le bloc « Sells on Euthyna Market » : les services du Market filtrés par vendeur ;
- sur la page société, le bouton « HIRE ITS AGENTS » qui y mène ;
- sur l'annuaire, le bloc « Already have a vault on EUTHYNA? ».

## La vidéo du héros

```html
<video class="hero-video" autoplay muted loop playsinline preload="metadata"
       poster="/assets/hero-poster.jpg" aria-hidden="true">
  <source src="/assets/hero-loop.mp4" type="video/mp4">
</video>
```

- **Cadrage** : en `object-fit: cover`, la stèle se place à droite du texte. En bureau, la stèle doit être vers 70 % de la largeur. En mobile, elle passe sous les boutons : voir `00-full-page-mobile.png`.
- **Accessibilité** : avec `prefers-reduced-motion: reduce`, ne pas lancer la vidéo et afficher l'image fixe. La vidéo est décorative, d'où `aria-hidden`.
- **En attendant le chargement**, l'image fixe s'affiche, ce qui évite un écran noir.

## Mobile (390 px)

Les règles sont dans le `@media (max-width: 900px)` du `<style>` de `site-home.html` :
- toutes les grilles passent sur une colonne ;
- les liens du menu sont masqués et seul « OPEN APP » reste ;
- la stèle passe sous le texte ;
- les titres EUTHYNA et ATLANTIS des dalles passent à 42 px ;
- le bandeau du coffre passe en 4:3 ;
- les codes d'erreur passent à la ligne au lieu de déborder.

Aucune barre de défilement horizontale.

## Animations (sobres)

- **Graver**, 400 ms : un titre apparaît par un masque de gauche à droite.
- **Frapper**, 220 ms : un sceau arrive avec une échelle de 1,15 à 1 et une légère rotation.
- **S'ouvrir**, 600 ms : un panneau ou une section glisse de 12 px vers le haut en fondu.
- **Pulser**, 1,2 s : les anneaux cyan d'Atlantis ou un statut « live ».

Ces animations se déclenchent une fois, à l'entrée dans l'écran. Rien ne bouge en boucle, sauf la vidéo du héros.

## Règles de vérité (les juges comparent le site au repo)

- Toute affirmation du site a sa ligne dans `CLAIMS.md` (Testnet / Code / Reported / NEXT).
- **Chaînes** :
  - Base Sepolia est prouvé.
  - Ethereum Sepolia et Solana devnet sont « Reported » tant que leurs hashes ne sont pas dans `docs/`.
  - Arbitrum, BSC, Plasma, Tron et Bitcoin sont PLANNED.
  - Ne jamais écrire « every chain » ni « all chains ».
- **NEAR** reste au second plan : pas dans le héros, pas de « on NEAR » en accroche. Il est cité dans Developers, la FAQ et le whitepaper.
- **Interdits** : aucune mention de JOIN, aucun concurrent nommé.
- **Données** : tout ce qui est un exemple est marqué comme tel (mandat de Naomi, sociétés de la carte, services du Market). Seul le hash `7FSbXRBN…LJvXv` de la page tâche vient du vrai test de bout en bout.

# Rules Manager

Plateforme de gestion des règles de détection de fraude : l'équipe fraude **crée, teste et suit** ses règles
sans passer par le mail, et mesure leur efficacité grâce au retour du prestataire (PRD v0.1).

## Structure

```
.
├── frontend/            React + TypeScript + Vite — l'IHM (Nginx non-root en production)
│   ├── src/api/         contrat d'API (client.ts, types.ts) + implémentation mock pour la démo
│   ├── src/pages/       écrans (liste, éditeur, détail, vue production, audit, profil)
│   └── nginx/           conf Nginx : sert la SPA et relaie /api vers l'API
├── backend/             Python 3.12 + FastAPI — l'API, un fichier par domaine (routes + logique)
│   ├── app/main.py      création de l'application, branchement des routes
│   ├── app/core.py      configuration (variables RM_*), erreurs, horloge
│   ├── app/database.py  connexion PostgreSQL, tables, écriture du journal d'audit
│   ├── app/schemas.py   formats JSON échangés avec le front
│   ├── app/auth.py      identification par matricule ; point UNIQUE de résolution de l'identité
│   ├── app/rules.py     règles : liste, création, versions, soumission (F1, F4, F5)
│   ├── app/query.py     test d'une requête : dry-run, exécution, garde-fous, budget (F3)
│   ├── app/sql_checks.py contrôles du SQL non couverts par BigQuery (@run_date, dates en dur…)
│   ├── app/pilotage.py  indicateurs de performance et journal d'audit, en lecture (F6, F7, F8)
│   ├── app/bigquery.py  tout l'accès BigQuery (réel ou factice), dont la publication dans rules_registry
│   ├── migrations/      Alembic (PostgreSQL / Cloud SQL)
│   └── tests/           pytest (SQLite en mémoire + BigQuery factice)
├── infra/
│   ├── bigquery/        contrat de données §7 : rules_registry, rule_runs, rule_alerts, v_rule_performance
│   └── cloudbuild.yaml  build → Artifact Registry → Cloud Run (+ job de migration)
├── docker-compose.yml   environnement local complet (PostgreSQL + API + front)
├── .github/workflows/   CI : typecheck, tests, lint, migrations sur PostgreSQL, build des images
└── Makefile
```

## Démarrer

Aucun Docker n'est nécessaire : en local, l'API tourne sur SQLite (un simple fichier) au lieu de PostgreSQL,
avec BigQuery simulé. Il faut seulement **Node.js**, **Python 3.12 ou plus** et **Git**.

### 1. Installer les outils (une seule fois)

**Windows** (PowerShell) — fermer puis rouvrir PowerShell après l'installation :
```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.12
winget install Git.Git
```

**macOS** (avec [Homebrew](https://brew.sh)) :
```bash
brew install node python@3.12 git
```

**Linux (Ubuntu/Debian)** :
```bash
sudo apt install -y git python3 python3-venv
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

Vérification : `node -v` (22.x ou plus) et `python --version` / `python3 --version` (3.12 ou plus).

### 2. Récupérer le code

```bash
git clone -b claude/rules-manager-prd-oldfut https://github.com/jxc18/ihm.git
cd ihm
```

### 3a. Voir l'interface seule (données simulées)

```bash
cd frontend
npm install
npm run dev
```
Ouvrir http://localhost:5173 et se connecter avec le matricule `104233` (ou `118870`, `120415`).

### 3b. Interface + vraie API

Deux terminaux, depuis le dossier du projet.

**Terminal 1 — API**

Windows (PowerShell) :
```powershell
cd backend
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
$env:RM_DATABASE_URL="sqlite:///./rules.db"; $env:RM_COOKIE_SECURE="false"
.venv\Scripts\alembic upgrade head
.venv\Scripts\uvicorn app.main:app --port 8000
```

macOS / Linux :
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
export RM_DATABASE_URL=sqlite:///./rules.db RM_COOKIE_SECURE=false
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8000
```
Documentation interactive de l'API : http://localhost:8000/docs

**Terminal 2 — interface branchée sur l'API**

Windows : `cd frontend`, `npm install`, puis `$env:VITE_API_MODE="http"; npm run dev`

macOS / Linux :
```bash
cd frontend
npm install
VITE_API_MODE=http npm run dev
```
Ouvrir http://localhost:5173. La base est vide : n'importe quel matricule à 6 chiffres, puis nom et prénom à la
première connexion.

### 4. Tests automatiques

```bash
cd frontend && npm test          # tests de l'interface
cd ../backend
.venv/bin/pytest -q              # tests de l'API (Windows : .venv\Scripts\pytest -q)
```

### Avec Docker (optionnel)

`docker compose up --build`, puis http://localhost:8081 (PostgreSQL + API + interface).

### À savoir

- Les variables d'environnement (`export …` / `$env:…`) ne valent que pour le terminal courant : les redéfinir
  si on le rouvre.
- En local, BigQuery est simulé : un test de requête répond toujours « 6 Go, 5 lignes » et les tableaux de
  performance sont vides. Pour le vrai BigQuery : accès GCP et `RM_BIGQUERY_MODE=real`.
- Le panneau « Simulation équipe data » (valider, mettre en production…) n'existe qu'en mode démo (3a).

### Dépannage : « npm is not recognized » (Windows)

Windows ne trouve pas Node.js : il n'est pas installé, ou le terminal a été ouvert avant son installation.

1. **Fermer et rouvrir le terminal** (toutes les fenêtres PowerShell, et VS Code si on utilise son terminal),
   puis vérifier avec `node -v` et `npm -v`.
2. **Installer Node.js** : `winget install OpenJS.NodeJS.LTS`, ou, si `winget` est inconnu, l'installateur **LTS**
   de https://nodejs.org (options par défaut, « Add to PATH » cochée). Rouvrir le terminal.
3. **Node installé mais npm introuvable** : le dossier n'est pas dans le PATH.
   ```powershell
   Test-Path "C:\Program Files\nodejs\npm.cmd"
   ```
   Si `True`, l'ajouter au PATH du compte puis rouvrir le terminal :
   ```powershell
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";C:\Program Files\nodejs", "User")
   ```
   Si `False`, relancer l'installateur.
4. **« L'exécution de scripts est désactivée sur ce système »** : autoriser les scripts pour son compte,
   ou utiliser l'Invite de commandes (`cmd`) à la place de PowerShell.
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

**PC d'entreprise sans droits administrateur** : prendre la version **.zip** sur
https://nodejs.org/en/download, la décompresser (par ex. dans `C:\Users\<vous>\node`) et ajouter ce dossier au
PATH avec la commande du point 3. Si le poste bloque aussi cela, demander l'installation au service informatique ;
en attendant, l'API se teste seule via http://localhost:8000/docs.

### Commandes du Makefile (macOS / Linux)

| Besoin | Commande |
|---|---|
| Tout installer | `make install` |
| Interface en mode démo | `make dev-front` |
| API locale (avec PostgreSQL : `make up-db`) | `make dev-api` |
| Interface branchée sur l'API | `make dev-front-http` |
| Tests / lint | `make test` · `make lint` |

### Configuration de l'API (variables `RM_*`, voir `backend/.env.example`)

| Variable | Rôle | Défaut |
|---|---|---|
| `RM_DATABASE_URL` | base applicative | PostgreSQL local |
| `RM_BIGQUERY_MODE` | `fake` (sans GCP) ou `real` | `fake` |
| `RM_GCP_PROJECT`, `RM_BQ_DATASET` | projet et dataset du contrat de données | — / `fraud_rules` |
| `RM_MAX_BYTES_BILLED`, `RM_JOB_TIMEOUT_MS`, `RM_MAX_RESULTS` | garde-fous des tests (F3) | 50 Go, 60 s, 100 |
| `RM_MONTHLY_BUDGET_BYTES` | budget de scan mensuel par utilisateur | 1 To (Q5) |
| `RM_NOTIFY_WEBHOOK_URL` | notification de l'équipe data à la soumission | vide = log (Q6) |

## Architecture (PRD §8)

```
navigateur ──► front (Nginx, Cloud Run) ──/api──► API FastAPI (Cloud Run) ──► Cloud SQL (état applicatif)
                                                           │
                                                           └──► BigQuery : dry-run / tests, rules_registry,
                                                                v_rule_performance, rule_runs  ◄── Airflow
```

- Le front ne détient aucun credential BigQuery ; il ne parle qu'à l'API, sur la même origine (cookie de session first-party).
- Les garde-fous de test (`maximumBytesBilled`, `jobTimeoutMs`, `maxResults`, budget) sont appliqués par l'API.
- Les lignes renvoyées par un test ne sont jamais persistées ni journalisées : seules les métadonnées le sont.
- L'identité (matricule) est résolue en un seul point, `get_current_user` dans `backend/app/auth.py` ; le front la relit toujours via `/me`.
  Passer au SSO (PRD §5.4) revient à réécrire `get_current_user`.

## Décisions prises dans ce squelette — à valider

- **Q1, base applicative** : PostgreSQL (recommandation du PRD §8.3). L'exposition à l'équipe data se fait par
  `rules_registry` dans BigQuery, alimentée à l'écriture (`publish_rule` dans `backend/app/bigquery.py`, mode `real`). Si vous choisissez
  une vue fédérée `EXTERNAL_QUERY`, cette synchronisation devient inutile.
- **Cycle de vie (écart au PRD F5 et §4.2)** : l'équipe data n'agit pas sur la plateforme. Seuls les gestes de
  l'analyste sont stockés (Brouillon, Soumise) ; le reste se **déduit des exécutions Airflow** dans `rule_runs` :
  - *En production* : la version tourne (Airflow écrit `airflow_dag_id` dans `rule_runs`) ;
  - *Inactive depuis X* : plus de run depuis 3 périodes (3 h, 3 jours ou 3 semaines selon la fréquence) ;
    le statut redevient « En production » dès que les runs reprennent ;
  - *Remplacée* : une version plus récente a été soumise ou tourne à sa place.

  Une version **soumise mais jamais exécutée** reste modifiable : elle repasse en brouillon (même numéro), sort de
  `rules_registry`, l'équipe data est prévenue (`RULE_SUBMISSION_WITHDRAWN`), puis elle doit être retestée et
  resoumise. **Les brouillons ne sont jamais écrits dans `rules_registry`** : ils restent dans la base de la
  plateforme (partagés entre postes et collègues), la saisie non enregistrée étant, elle, gardée dans le navigateur. Dès qu'une version
  a tourné, elle est figée et toute modification crée une nouvelle version.

  **Contrat côté Airflow, à valider avec l'équipe data** : le DAG ne recopie pas la requête, il l'exécute telle
  qu'il la trouve dans `rules_registry`. Comme la table garde une ligne par version, il prend la **dernière
  version soumise** de sa règle, identifiée par son `rule_id` (le nom est modifiable) : c'est le filtre que
  fait la vue `v_rules_active` (`infra/bigquery/05_v_rules_active.sql`). Il écrit dans `rule_runs` la version
  qu'il a exécutée : c'est ce qui permet à la plateforme d'afficher quelle version tourne. Une nouvelle version soumise tourne donc dès le
  run suivant, sans action de l'équipe data, qui n'intervient que pour créer le DAG d'une nouvelle règle. Les
  brouillons ne sont jamais exécutés. Toutes les versions restent conservées dans la plateforme : comparatif
  SQL, comparaison des performances par version (repères sur les courbes, tableau par version) et
  **restauration** d'une version antérieure, recopiée en nouvelle version à tester puis soumettre.

  Les statuts « Validée » et « Refusée » disparaissent : un refus passe hors plateforme et l'analyste soumet
  une nouvelle version (risque R3 : le motif n'est pas tracé). L'état des runs est recopié par
  `POST /internal/sync-runs`, à appeler périodiquement (Cloud Scheduler, toutes les heures par exemple).
- **Contraintes SQL « avant enregistrement »** : seul le DML/DDL bloque l'enregistrement d'un brouillon ;
  `order_id`, `@run_date` et les dates en dur bloquent la soumission.
- **Paramètres (écart au PRD F2)** : pas de paramètres déclarés. Les seuils s'écrivent en dur dans le SQL
  (`amount_eur >= 500`) et leur évolution se lit dans le comparatif entre versions. `@run_date` est le seul
  paramètre : Airflow fournit la date du run sans modifier la requête, ce qui permet relances et rattrapages.
  `rules_registry` n'a donc pas de colonne `parameters`.
- **Identité** : `owner_matricule` remplace `owner_email` dans `rules_registry`.
- **@run_date pendant un test** : la veille (dernière journée complète), affichée dans le bloc de test.
  La période réellement couverte dépend de la requête (ex. fenêtre de 7 jours avant `@run_date`).
- **Règles horaires** : `@run_date` est une date sans heure ; une fréquence horaire demandera une fenêtre
  (`@run_start` / `@run_end`) à définir avec l'équipe data.
- **Déploiement** : API en ingress interne sans IAM entre front et API (le contrôle d'accès est réseau, PRD F8).
  La topologie exacte (load balancer interne, routage `/api`) reste à arbitrer.
- **Valeurs provisoires** : typologies de fraude (Q4, `frontend/src/lib/format.ts`), budget mensuel (Q5),
  colonnes de la table de feedback (Q2, `infra/bigquery/04_v_rule_performance.sql`).

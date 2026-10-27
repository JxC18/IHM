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
├── backend/             Python 3.12 + FastAPI — l'API
│   ├── app/auth.py      point UNIQUE de résolution de l'identité (get_current_user)
│   ├── app/routers/     endpoints HTTP (mêmes chemins que frontend/src/api/client.ts)
│   ├── app/services/    métier : règles & versions, test de requête, BigQuery, registre, audit
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

| Besoin | Commande |
|---|---|
| Voir l'IHM seule, données simulées | `cd frontend && npm install && npm run dev` → http://localhost:5173 |
| Tout en conteneurs (PostgreSQL + API + front) | `docker compose up --build` → http://localhost:8081 |
| Développer l'API | `make up-db` puis `make dev-api` (port 8000), et `make dev-front-http` pour le front branché dessus |
| Tests | `make test` · lint API : `make lint` |

Connexion : n'importe quel matricule à 6 chiffres ; un matricule inconnu déclenche la saisie nom / prénom.
En mode démo, les matricules `104233`, `118870`, `120415` ont déjà des règles.

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
- L'identité (matricule) est résolue en un seul point, `backend/app/auth.py` ; le front la relit toujours via `/me`.
  Passer au SSO (PRD §5.4) revient à réécrire `get_current_user`.

## Décisions prises dans ce squelette — à valider

- **Q1, base applicative** : PostgreSQL (recommandation du PRD §8.3). L'exposition à l'équipe data se fait par
  `rules_registry` dans BigQuery, alimentée à l'écriture (`services/registry.py`, mode `real`). Si vous choisissez
  une vue fédérée `EXTERNAL_QUERY`, cette synchronisation devient inutile.
- **Statuts posés par l'équipe data** (VALIDATED, IN_PRODUCTION…) : le PRD prévoit une écriture directe en base.
  Avec PostgreSQL comme source de vérité, l'équipe data doit écrire dans `rule_versions` (pas dans BigQuery),
  ou un back-office minimal est nécessaire (R3). À trancher avec elle.
- **Contraintes SQL « avant enregistrement »** : seul le DML/DDL bloque l'enregistrement d'un brouillon ;
  `order_id`, `@run_date` et les dates en dur bloquent la soumission.
- **Identité** : `owner_matricule` remplace `owner_email` dans `rules_registry`.
- **@run_date pendant un test** : la veille (dernière journée complète).
- **Déploiement** : API en ingress interne sans IAM entre front et API (le contrôle d'accès est réseau, PRD F8).
  La topologie exacte (load balancer interne, routage `/api`) reste à arbitrer.
- **Valeurs provisoires** : typologies de fraude (Q4, `frontend/src/lib/format.ts`), budget mensuel (Q5),
  colonnes de la table de feedback (Q2, `infra/bigquery/04_v_rule_performance.sql`).

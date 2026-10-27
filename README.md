# Rules Manager — interface (V1)

Front-end de la plateforme de gestion des règles de détection de fraude décrite dans le PRD (v0.1).
React + TypeScript + Vite, conteneur Nginx non-root pour Cloud Run (PRD §8).

## Démarrer

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 — mode démo par défaut
npm test           # tests unitaires (vitest)
npm run build
```

Connexion : n'importe quel matricule à 6 chiffres. Matricules de démo déjà connus : `104233`, `118870`, `120415`.
Un matricule inconnu déclenche la saisie nom / prénom (première connexion).

## Deux modes d'API

| Mode | Activation | Usage |
|---|---|---|
| `mock` (défaut) | — | Démo / dev sans back-end : données simulées, dry-run et exécution BigQuery simulés (`src/api/mock`). Un panneau « Simulation équipe data » permet de faire avancer le cycle de vie. |
| `http` | `VITE_API_MODE=http` | Appelle l'API FastAPI sous `/api` (cookie de session). Le contrat attendu est dans `src/api/client.ts` (`createHttpApi`). |

## Couverture du PRD

| Exigence | Écran / composant |
|---|---|
| F1 Référentiel | `RulesListPage` (filtres statut / typologie / propriétaire / criticité, tri par date, recherche plein texte nom + description + SQL), unicité du nom vérifiée à la saisie |
| F2 Éditeur SQL | `SqlEditor` (CodeMirror, dialecte GoogleSQL), `ParamsEditor` : détection des `@param` non déclarés / inutilisés, `@run_date` réservé |
| F3 Test | `TestPanel` : dry-run → confirmation → échantillon (100 lignes), garde-fous affichés, refus au-delà du plafond, budget mensuel, erreurs surlignées dans l'éditeur avec lien ligne/colonne. Les lignes ne sont jamais persistées |
| F4 Soumission | Bouton actif uniquement si le dernier test est une exécution réussie sur la version courante (empreinte requête + paramètres) |
| F5 Cycle de vie | Statuts, création automatique d'une nouvelle version au-delà de `DRAFT`, onglet Versions avec diff SQL et diff des paramètres |
| F6 Performance | `PerformanceDashboard` : 3 tuiles avec variation, deux courbes séparées (jamais de double axe), réticule + infobulle (souris et clavier), zone de latence prestataire, alerte échantillon faible, mentions rappel / non-additivité, table des runs |
| F7 Vue consolidée | `ProductionPage` : tri par précision / volume, seuil « à surveiller » paramétrable, règles sans remontée sur 30 j |
| F8 Identification | Saisie du matricule (format seul), profil serveur, préférences en `localStorage`, identité toujours relue via `/me`, journal d'audit (global et par règle) |

## Points d'interprétation à valider

- **Contraintes SQL « avant enregistrement »** : seul le DML/DDL bloque l'enregistrement d'un brouillon ; `order_id`, `@run_date` et les dates en dur bloquent la *soumission*. Sinon un brouillon en cours d'écriture ne pourrait pas être sauvegardé.
- **Typologies de fraude** : liste provisoire dans `src/lib/format.ts` (PRD Q4).
- **Budget mensuel** : 1 To en démo (PRD Q5).
- **Identité** : `owner_email` du schéma §7.2 remplacé par le matricule (cohérent avec §5.4).
- Les volumes affichés somment les remontées journalières ; si une commande peut être remontée plusieurs jours, le back-end devra renvoyer des totaux dédupliqués sur la période.

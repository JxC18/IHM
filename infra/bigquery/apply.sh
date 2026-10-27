#!/usr/bin/env bash
# Crée les tables du contrat de données (Lot 3). Usage :
#   PROJECT=mon-projet DATASET=fraud_rules FEEDBACK_TABLE=dataset.table ./apply.sh
set -euo pipefail
: "${PROJECT:?}" "${DATASET:?}" "${FEEDBACK_TABLE:?}"
cd "$(dirname "$0")"
bq --project_id="$PROJECT" mk --dataset --force --location="${LOCATION:-EU}" "$PROJECT:$DATASET" >/dev/null
for f in 0*.sql; do
  echo "→ $f"
  envsubst '${PROJECT} ${DATASET} ${FEEDBACK_TABLE}' < "$f" | bq --project_id="$PROJECT" query --use_legacy_sql=false --quiet
done

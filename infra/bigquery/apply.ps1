<#
.SYNOPSIS
  Crée les tables du contrat de données dans BigQuery (équivalent Windows de apply.sh).

.DESCRIPTION
  Crée le dataset s'il n'existe pas, puis exécute dans l'ordre les fichiers 0*.sql de ce dossier
  après y avoir remplacé ${PROJECT}, ${DATASET} et ${FEEDBACK_TABLE}. Peut être rejoué sans risque.
  Prérequis : Google Cloud SDK (commande bq) et une connexion faite avec « gcloud auth login ».

.EXAMPLE
  .\apply.ps1 -Project mon-projet -Dataset fraud_rules -FeedbackTable prestataire.feedback

.EXAMPLE
  # Valeurs lues dans les variables d'environnement si les paramètres sont omis :
  $env:PROJECT = "mon-projet"; $env:DATASET = "fraud_rules"; $env:FEEDBACK_TABLE = "prestataire.feedback"
  .\apply.ps1
#>
param(
  [string]$Project = $env:PROJECT,
  [string]$Dataset = $env:DATASET,
  # Table de retour du prestataire, au format dataset.table (sans le projet) : utilisée par v_rule_performance.
  [string]$FeedbackTable = $env:FEEDBACK_TABLE,
  [string]$Location = $(if ($env:LOCATION) { $env:LOCATION } else { 'EU' })
)

$ErrorActionPreference = 'Stop'

$missing = @()
if (-not $Project) { $missing += 'Project (ou $env:PROJECT)' }
if (-not $Dataset) { $missing += 'Dataset (ou $env:DATASET)' }
if (-not $FeedbackTable) { $missing += 'FeedbackTable (ou $env:FEEDBACK_TABLE)' }
if ($missing) { throw "Paramètres manquants : $($missing -join ', ')" }

if (-not (Get-Command bq -ErrorAction SilentlyContinue)) {
  throw "Commande bq introuvable : installer le Google Cloud SDK (https://cloud.google.com/sdk/docs/install), puis rouvrir PowerShell."
}

# Le SQL est envoyé à bq par l'entrée standard : UTF-8 pour garder les accents des commentaires.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

bq --project_id=$Project mk --dataset --force --location=$Location "${Project}:${Dataset}" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Création du dataset ${Project}:${Dataset} impossible." }

$vars = @{ PROJECT = $Project; DATASET = $Dataset; FEEDBACK_TABLE = $FeedbackTable }
foreach ($file in Get-ChildItem -Path $PSScriptRoot -Filter '0*.sql' | Sort-Object Name) {
  Write-Host "→ $($file.Name)"
  $sql = Get-Content -Raw -Encoding UTF8 $file.FullName
  foreach ($var in $vars.GetEnumerator()) { $sql = $sql.Replace('${' + $var.Key + '}', $var.Value) }
  $sql | bq --project_id=$Project query --use_legacy_sql=false --quiet
  if ($LASTEXITCODE -ne 0) { throw "Échec de $($file.Name) (voir le message de bq ci-dessus)." }
}

Write-Host "Terminé : dataset ${Project}:${Dataset} à jour."

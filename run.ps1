<#
.SYNOPSIS
  Lance Rules Manager en une commande sous Windows (équivalent du Makefile) : installe ce qui manque,
  prépare la base locale, démarre l'API puis l'interface et ouvre le navigateur.

.DESCRIPTION
  Premier lancement : crée l'environnement Python (backend\.venv), installe les dépendances Python et
  npm, crée backend\.env (SQLite, BigQuery simulé) s'il n'existe pas. Lancements suivants : ne réinstalle
  que si pyproject.toml ou package-lock.json a changé. Ctrl+C arrête l'interface et l'API.

.PARAMETER Demo
  Interface seule, données simulées dans le navigateur (pas de Python nécessaire).

.PARAMETER Install
  Force la réinstallation des dépendances.

.EXAMPLE
  .\run.cmd                 # double-clic possible
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\run.ps1 -Demo
#>
param(
  [switch]$Demo,
  [switch]$Install,
  [int]$ApiPort = 8000
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

function Step($text) { Write-Host "`n▶ $text" -ForegroundColor Cyan }

# Vrai si la cible est absente ou plus ancienne que la source (pour ne réinstaller qu'au besoin).
function NeedsUpdate($stamp, $source) {
  -not (Test-Path $stamp) -or (Get-Item $source).LastWriteTime -gt (Get-Item $stamp).LastWriteTime
}

# ---------------------------------------------------------------- outils
Step 'Vérification des outils'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js introuvable. Installer la version LTS (winget install OpenJS.NodeJS.LTS ou https://nodejs.org), puis rouvrir PowerShell."
}
Write-Host "  Node.js $(node -v)"

$python = $null
if (-not $Demo) {
  # Python 3.12 ou plus : lanceur py d'abord, puis python.
  foreach ($candidate in @(@('py', '-3.13'), @('py', '-3.12'), @('python'))) {
    if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
    $exe = $candidate[0]; $rest = @($candidate | Select-Object -Skip 1)
    # try/catch : sous Windows PowerShell 5.1, une sortie d'erreur redirigée lève une exception avec 'Stop'.
    try { $ok = & $exe @rest -c 'import sys; print(sys.version_info >= (3, 12))' 2>$null } catch { continue }
    if ($LASTEXITCODE -eq 0 -and "$ok".Trim() -eq 'True') { $python = $candidate; break }
  }
  if (-not $python) {
    throw "Python 3.12 ou plus introuvable. Installer : winget install Python.Python.3.12, puis rouvrir PowerShell. (Ou lancer l'interface seule avec -Demo.)"
  }
  $exe = $python[0]; $rest = @($python | Select-Object -Skip 1)
  Write-Host "  $(& $exe @rest --version)"
}

# ---------------------------------------------------------------- API
$api = $null
if (-not $Demo) {
  Push-Location $backend
  try {
    $venvPython = Join-Path $backend '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
      Step 'Création de l''environnement Python (backend\.venv)'
      & $exe @rest -m venv .venv
      if ($LASTEXITCODE -ne 0) { throw 'Création de backend\.venv impossible.' }
    }
    $stamp = Join-Path $backend '.venv\.installed'
    if ($Install -or (NeedsUpdate $stamp (Join-Path $backend 'pyproject.toml'))) {
      Step 'Installation des dépendances Python'
      & $venvPython -m pip install --disable-pip-version-check -q -e '.[dev]'
      if ($LASTEXITCODE -ne 0) { throw 'pip install a échoué (voir ci-dessus).' }
      Set-Content -Path $stamp -Value (Get-Date -Format o)
    }

    if (-not (Test-Path '.env')) {
      Step 'Création de backend\.env (SQLite local, BigQuery simulé)'
      @(
        'RM_ENV=local'
        'RM_DATABASE_URL=sqlite:///./rules.db'
        'RM_BIGQUERY_MODE=fake'
        'RM_COOKIE_SECURE=false'
      ) | Set-Content -Path '.env' -Encoding ASCII
    }

    Step 'Mise à jour de la base (alembic upgrade head)'
    & $venvPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'La migration de la base a échoué (voir ci-dessus).' }

    Step "Démarrage de l'API sur http://localhost:$ApiPort (journal : backend\api.log)"
    $api = Start-Process -FilePath $venvPython -WorkingDirectory $backend -NoNewWindow -PassThru `
      -ArgumentList '-m', 'uvicorn', 'app.main:app', '--port', $ApiPort `
      -RedirectStandardOutput (Join-Path $backend 'api.log') -RedirectStandardError (Join-Path $backend 'api-errors.log')

    # On attend que l'API réponde avant d'ouvrir l'interface.
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $api.HasExited; $i++) {
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$ApiPort/healthz" | Out-Null; $ready = $true; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) {
      Get-Content (Join-Path $backend 'api-errors.log') -Tail 20 -ErrorAction SilentlyContinue | Write-Host
      throw "L'API ne répond pas (voir backend\api-errors.log). Port $ApiPort déjà utilisé ? Essayer -ApiPort 8001."
    }
    Write-Host '  API prête.'
  }
  finally { Pop-Location }
}

# ---------------------------------------------------------------- interface
try {
  Push-Location $frontend
  if ($Install -or -not (Test-Path 'node_modules') -or (NeedsUpdate 'node_modules\.package-lock.json' 'package-lock.json')) {
    Step 'Installation des dépendances npm'
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install a échoué (voir ci-dessus).' }
  }

  $env:VITE_API_MODE = if ($Demo) { 'mock' } else { 'http' }
  $env:API_URL = "http://localhost:$ApiPort"
  Step $(if ($Demo) { 'Interface en mode démo (données simulées)' } else { "Interface branchée sur l'API" })
  Write-Host '  http://localhost:5173 s''ouvre dans le navigateur. Ctrl+C pour tout arrêter.' -ForegroundColor Green
  # Vite lancé directement (pas via npm.cmd) : Ctrl+C arrête sans la question « Terminer le programme de commandes ? ».
  node node_modules\vite\bin\vite.js --open
}
finally {
  Pop-Location
  if ($api -and -not $api.HasExited) {
    Write-Host "`nArrêt de l'API…"
    Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
  }
}

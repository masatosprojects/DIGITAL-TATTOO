# Windows helper: fetch offline WebLLM artifacts into public/models/
# Requires network once. Runtime never calls this.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "DIGITAL TATTOO — fetch-model (PowerShell)"
node .\scripts\fetch-model.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

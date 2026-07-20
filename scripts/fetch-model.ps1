# Windows helper: fetch offline WebLLM artifacts into public/models/
# Requires network once. Runtime never calls this.
# Usage:
#   .\scripts\fetch-model.ps1           # default 1.5B
#   .\scripts\fetch-model.ps1 lite      # 0.5B
#   .\scripts\fetch-model.ps1 hq        # 3B
#   .\scripts\fetch-model.ps1 --all     # all
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "DIGITAL TATTOO — fetch-model (PowerShell)"
if ($args.Count -gt 0) {
  node .\scripts\fetch-model.mjs @args
} else {
  node .\scripts\fetch-model.mjs
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

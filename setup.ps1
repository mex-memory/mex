#Requires -Version 5.1
<#
.SYNOPSIS
  Windows-native mex setup for git-clone installs.

.DESCRIPTION
  Builds the mex CLI with native Windows Node, then runs interactive setup.
  Use this instead of setup.sh when you are not in WSL/Git Bash.

  Run from your project root:
    .\.mex\setup.ps1

  If you already ran setup.sh in WSL and see "Cannot find module" errors from
  PowerShell, this script rebuilds the bundled CLI so it runs without
  .mex\node_modules.
#>
param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = (Get-Location).Path

if ($ScriptDir -eq $ProjectDir) {
  Write-Error "Run this script from your project root, not from inside .mex."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required. Install Node 20+ and try again."
}

Write-Host ""
Write-Host "mex setup (Windows)" -ForegroundColor White
Write-Host ""

Write-Host "-> Building mex CLI with native Windows Node..."
Push-Location $ScriptDir
try {
  npm install --silent 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed in .mex"
  }
  npm run build --silent 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed in .mex"
  }
} finally {
  Pop-Location
}

Write-Host "OK CLI engine built" -ForegroundColor Green
Write-Host ""

$setupArgs = @("setup")
if ($DryRun) {
  $setupArgs += "--dry-run"
}

& node (Join-Path $ScriptDir "dist\cli.js") @setupArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "OK Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "-> Verify: ask your AI tool to read .mex/ROUTER.md"
Write-Host "-> Run: node .mex/dist/cli.js check"
Write-Host "-> Or:  npx mex-agent check"

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Node.js 20.9+ is required. Install Node.js LTS, reopen PowerShell, and retry.' }
$Version = (& node -p "process.versions.node").Trim()
$Parts = $Version.Split('.')
$Major = [int]$Parts[0]
$Minor = [int]$Parts[1]
if (($Major -lt 20) -or (($Major -eq 20) -and ($Minor -lt 9))) { throw "Node.js 20.9+ required. Found $Version." }
Write-Host "Node.js $Version detected. Running checks..." -ForegroundColor Cyan
npm test
npm run check
Write-Host 'Starting EventPilot AI on http://127.0.0.1:3000' -ForegroundColor Green
npm start

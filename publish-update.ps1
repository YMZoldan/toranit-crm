# Publish a new version zip to your GitHub repository.
# Run from inside the repository folder:
#   powershell -ExecutionPolicy Bypass -File .\publish-update.ps1 "E:\USB 16\downloads\cameras-v1.5.0.zip"
param([Parameter(Mandatory = $true)][string]$Zip)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
if (-not (Test-Path (Join-Path $repo '.git'))) { throw "Run this script from inside the git repository folder." }
if (-not (Test-Path -LiteralPath $Zip)) { throw "Zip file not found: $Zip" }
$tmp = Join-Path $env:TEMP ('cam-' + [guid]::NewGuid())
Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
$src = Join-Path $tmp 'cameras'
if (-not (Test-Path (Join-Path $src 'VERSION'))) { Remove-Item $tmp -Recurse -Force; throw "This zip is not a cable-planner package." }
$ver = (Get-Content (Join-Path $src 'VERSION') -Raw).Trim()
Get-ChildItem -LiteralPath $repo -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $src '*') -Destination $repo -Recurse -Force
Remove-Item $tmp -Recurse -Force
Set-Location $repo
git add -A
git commit -m "v$ver"
git tag -f "v$ver"
git push origin HEAD
git push -f origin "v$ver"
Write-Host ""
Write-Host "Published v$ver to GitHub. On the server run:  cameras-update" -ForegroundColor Green

param(
	[string]$Workspace = (Join-Path $HOME ".familiar"),
	[string]$Package = "@qearlyao/familiar@latest",
	[switch]$WithBrowser,
	[switch]$SkipInit
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "Missing required command: $Name"
	}
}

Require-Command node
Require-Command npm

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 22) {
	throw "Familiar requires Node.js 22 or newer. Found Node.js $nodeVersion. Node.js 24 LTS is recommended."
}
if ($nodeMajor -lt 24) {
	Write-Host "Found Node.js $nodeVersion. Familiar supports Node.js 22+, but Node.js 24 LTS is recommended."
}

Write-Host "Installing $Package globally..."
& npm install -g $Package
if ($LASTEXITCODE -ne 0) {
	throw "npm install failed."
}

if ($WithBrowser) {
	Write-Host "Installing optional browser helper CLIs..."
	& npm install -g "@jackwener/opencli" "browser-harness"
	if ($LASTEXITCODE -ne 0) {
		throw "browser helper install failed."
	}
}

if (-not (Get-Command familiar -ErrorAction SilentlyContinue)) {
	throw "Installed package, but familiar is not on PATH. Check your npm global bin directory and rerun: familiar init `"$Workspace`""
}

if (-not $SkipInit) {
	$configPath = Join-Path $Workspace "config.toml"
	if (Test-Path $configPath) {
		Write-Host "Workspace already exists at $Workspace; leaving files unchanged."
	} else {
		Write-Host "Initializing workspace at $Workspace..."
		& familiar init $Workspace
		if ($LASTEXITCODE -ne 0) {
			throw "familiar init failed."
		}
	}
}

Write-Host ""
Write-Host "Familiar is installed."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit $Workspace\.env"
Write-Host "  2. Edit $Workspace\config.toml"
Write-Host "  3. Run: familiar run `"$Workspace`""
Write-Host ""
Write-Host "Optional browser helpers:"
Write-Host "  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.ps1))) -WithBrowser"

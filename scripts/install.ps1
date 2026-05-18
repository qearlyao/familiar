param(
	[string]$Workspace = (Join-Path $HOME ".familiar"),
	[string]$Package = "@qearlyao/familiar@latest",
	[string]$BrowserHarnessDir = (Join-Path (Join-Path $HOME "Developer") "browser-harness"),
	[switch]$WithBrowser,
	[switch]$SkipInit
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "Missing required command: $Name"
	}
}

function Test-Python311($Command, $PythonArgs = @()) {
	& $Command @PythonArgs -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" *> $null
	return $LASTEXITCODE -eq 0
}

function Resolve-Python311 {
	$python = Get-Command python -ErrorAction SilentlyContinue
	if ($python -and (Test-Python311 $python.Source)) {
		return @{ Command = $python.Source; Args = @(); UvPython = $python.Source }
	}
	$python3 = Get-Command python3 -ErrorAction SilentlyContinue
	if ($python3 -and (Test-Python311 $python3.Source)) {
		return @{ Command = $python3.Source; Args = @(); UvPython = $python3.Source }
	}
	$py = Get-Command py -ErrorAction SilentlyContinue
	if ($py -and (Test-Python311 $py.Source @("-3.11"))) {
		return @{ Command = $py.Source; Args = @("-3.11"); UvPython = "3.11" }
	}
	throw "browser-harness requires Python 3.11 or newer. Install Python 3.11+ and rerun with -WithBrowser."
}

Require-Command node
Require-Command npm
if ($WithBrowser) {
	Require-Command git
	Require-Command uv
	$Python311 = Resolve-Python311
}

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
	Write-Host "Installing optional OpenCLI browser helper..."
	& npm install -g "@jackwener/opencli"
	if ($LASTEXITCODE -ne 0) {
		throw "browser helper install failed."
	}

	Write-Host "Installing optional browser-harness helper into $BrowserHarnessDir..."
	$gitDir = Join-Path $BrowserHarnessDir ".git"
	if (Test-Path $gitDir) {
		& git -C $BrowserHarnessDir pull --ff-only
		if ($LASTEXITCODE -ne 0) {
			throw "browser-harness update failed."
		}
	} elseif (Test-Path $BrowserHarnessDir) {
		throw "Cannot install browser-harness: $BrowserHarnessDir already exists and is not a git checkout."
	} else {
		$parentDir = Split-Path -Parent $BrowserHarnessDir
		New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
		& git clone https://github.com/browser-use/browser-harness $BrowserHarnessDir
		if ($LASTEXITCODE -ne 0) {
			throw "browser-harness clone failed."
		}
	}
	Push-Location $BrowserHarnessDir
	$previousUvPython = $env:UV_PYTHON
	try {
		$env:UV_PYTHON = $Python311.UvPython
		& uv tool install -e .
		if ($LASTEXITCODE -ne 0) {
			throw "browser-harness install failed."
		}
	} finally {
		if ($null -eq $previousUvPython) {
			Remove-Item Env:\UV_PYTHON -ErrorAction SilentlyContinue
		} else {
			$env:UV_PYTHON = $previousUvPython
		}
		Pop-Location
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
Write-Host ""
Write-Host "browser-harness checkout:"
Write-Host "  $BrowserHarnessDir"

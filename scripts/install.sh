#!/usr/bin/env sh
set -eu

PACKAGE="@qearlyao/familiar@latest"
WORKSPACE="${HOME}/.familiar"
BROWSER_HARNESS_DIR="${HOME}/Developer/browser-harness"
WITH_BROWSER=0
INSTALL_BROWSER_DEPS=0
SKIP_INIT=0

usage() {
	cat <<'EOF'
Usage: install.sh [options]

Options:
  --workspace <path>   Workspace path to initialize. Defaults to ~/.familiar.
  --with-browser       Also install optional OpenCLI and browser-harness helpers.
  --install-browser-deps
                       With --with-browser, install missing uv/Python 3.11 browser deps without prompting.
  --skip-init          Install familiar but do not run familiar init.
  --package <spec>     npm package spec to install. Defaults to @qearlyao/familiar@latest.
                       Advanced: installs the exact npm spec provided; use trusted specs only.
  -h, --help           Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--workspace)
			if [ "$#" -lt 2 ]; then
				echo "Missing value for --workspace" >&2
				exit 1
			fi
			WORKSPACE="$2"
			shift 2
			;;
		--with-browser)
			WITH_BROWSER=1
			shift
			;;
		--install-browser-deps)
			INSTALL_BROWSER_DEPS=1
			shift
			;;
		--skip-init)
			SKIP_INIT=1
			shift
			;;
		--package)
			if [ "$#" -lt 2 ]; then
				echo "Missing value for --package" >&2
				exit 1
			fi
			PACKAGE="$2"
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

need_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

refresh_browser_dep_path() {
	for candidate in "${HOME}/.local/bin" "${HOME}/.cargo/bin"; do
		if [ -d "$candidate" ]; then
			case ":${PATH}:" in
				*":${candidate}:"*) ;;
				*) PATH="${candidate}:${PATH}" ;;
			esac
		fi
	done
	export PATH
}

confirm_browser_dep_install() {
	if [ "$INSTALL_BROWSER_DEPS" -eq 1 ]; then
		return 0
	fi
	if [ -r /dev/tty ] && [ -w /dev/tty ]; then
		printf "%s Install it now? [y/N] " "$1" >/dev/tty
		read -r answer </dev/tty || answer=""
		case "$answer" in
			y | Y | yes | YES) return 0 ;;
		esac
	fi
	return 1
}

install_uv() {
	echo "Installing uv for browser-harness..."
	if command -v curl >/dev/null 2>&1; then
		curl -LsSf https://astral.sh/uv/install.sh | sh
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- https://astral.sh/uv/install.sh | sh
	else
		echo "Missing curl or wget, which is required to install uv automatically." >&2
		echo "Install uv manually from https://docs.astral.sh/uv/ and rerun with --with-browser." >&2
		exit 1
	fi
	refresh_browser_dep_path
	if ! command -v uv >/dev/null 2>&1; then
		echo "uv installer finished, but uv is not on PATH. Open a new terminal or add ~/.local/bin to PATH." >&2
		exit 1
	fi
}

ensure_uv() {
	if command -v uv >/dev/null 2>&1; then
		return 0
	fi
	if confirm_browser_dep_install "uv is required for browser-harness but was not found."; then
		install_uv
		return 0
	fi
	echo "Missing required command: uv" >&2
	echo "Rerun with --with-browser --install-browser-deps to install uv and Python 3.11 automatically." >&2
	exit 1
}

find_python() {
	PYTHON_PATH=""
	for candidate in python3 python; do
		if command -v "$candidate" >/dev/null 2>&1; then
			CANDIDATE_PATH="$(command -v "$candidate")"
			if "$CANDIDATE_PATH" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
				PYTHON_PATH="$CANDIDATE_PATH"
				return 0
			fi
		fi
	done
	return 1
}

ensure_python() {
	if find_python; then
		return 0
	fi
	if confirm_browser_dep_install "Python 3.11+ is required for browser-harness but was not found."; then
		echo "Installing Python 3.11 with uv for browser-harness..."
		uv python install 3.11
		PYTHON_PATH="3.11"
		return 0
	fi
	echo "browser-harness requires Python 3.11 or newer." >&2
	echo "Rerun with --with-browser --install-browser-deps to install uv-managed Python 3.11 automatically." >&2
	exit 1
}

need_command node
need_command npm
if [ "$WITH_BROWSER" -eq 1 ]; then
	need_command git
	ensure_uv
	ensure_python
fi

NODE_VERSION="$(node -p "process.versions.node")"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "Familiar requires Node.js 22 or newer. Found Node.js ${NODE_VERSION}." >&2
	echo "Node.js 24 LTS is recommended for the smoothest install." >&2
	exit 1
fi
if [ "$NODE_MAJOR" -lt 24 ]; then
	echo "Found Node.js ${NODE_VERSION}. Familiar supports Node.js 22+, but Node.js 24 LTS is recommended."
fi

echo "Installing ${PACKAGE} globally..."
npm install -g "$PACKAGE"

if [ "$WITH_BROWSER" -eq 1 ]; then
	echo "Installing optional OpenCLI browser helper..."
	npm install -g @jackwener/opencli

	echo "Installing optional browser-harness helper into ${BROWSER_HARNESS_DIR}..."
	if [ -d "${BROWSER_HARNESS_DIR}/.git" ]; then
		git -C "$BROWSER_HARNESS_DIR" pull --ff-only
	elif [ -e "$BROWSER_HARNESS_DIR" ]; then
		echo "Cannot install browser-harness: ${BROWSER_HARNESS_DIR} already exists and is not a git checkout." >&2
		exit 1
	else
		mkdir -p "$(dirname "$BROWSER_HARNESS_DIR")"
		git clone https://github.com/browser-use/browser-harness "$BROWSER_HARNESS_DIR"
	fi
	(cd "$BROWSER_HARNESS_DIR" && UV_PYTHON="$PYTHON_PATH" uv tool install -e .)
fi

if ! command -v familiar >/dev/null 2>&1; then
	echo "Installed package, but familiar is not on PATH." >&2
	echo "Check your npm global bin directory and shell PATH, then rerun: familiar init ${WORKSPACE}" >&2
	exit 1
fi

if [ "$SKIP_INIT" -eq 0 ]; then
	echo "Initializing or refreshing workspace defaults at ${WORKSPACE}..."
	familiar init "$WORKSPACE"
fi

cat <<EOF

Familiar is installed.

Next steps:
  1. Edit ${WORKSPACE}/.env
  2. Edit ${WORKSPACE}/config.toml
  3. Run: familiar run ${WORKSPACE}

Optional browser helpers:
  curl -fsSL https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.sh | sh -s -- --with-browser

browser-harness checkout:
  ${BROWSER_HARNESS_DIR}
EOF

#!/usr/bin/env sh
set -eu

PACKAGE="@qearlyao/familiar@latest"
WORKSPACE="${HOME}/.familiar"
WITH_BROWSER=0
SKIP_INIT=0

usage() {
	cat <<'EOF'
Usage: install.sh [options]

Options:
  --workspace <path>   Workspace path to initialize. Defaults to ~/.familiar.
  --with-browser       Also install optional browser helper CLIs.
  --skip-init          Install familiar but do not run familiar init.
  --package <spec>     npm package spec to install. Defaults to @qearlyao/familiar@latest.
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

need_command node
need_command npm

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
	echo "Installing optional browser helper CLIs..."
	npm install -g @jackwener/opencli browser-harness
fi

if ! command -v familiar >/dev/null 2>&1; then
	echo "Installed package, but familiar is not on PATH." >&2
	echo "Check your npm global bin directory and shell PATH, then rerun: familiar init ${WORKSPACE}" >&2
	exit 1
fi

if [ "$SKIP_INIT" -eq 0 ]; then
	if [ -f "${WORKSPACE}/config.toml" ]; then
		echo "Workspace already exists at ${WORKSPACE}; leaving files unchanged."
	else
		echo "Initializing workspace at ${WORKSPACE}..."
		familiar init "$WORKSPACE"
	fi
fi

cat <<EOF

Familiar is installed.

Next steps:
  1. Edit ${WORKSPACE}/.env
  2. Edit ${WORKSPACE}/config.toml
  3. Run: familiar run ${WORKSPACE}

Optional browser helpers:
  curl -fsSL https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.sh | sh -s -- --with-browser
EOF

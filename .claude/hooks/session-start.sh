#!/bin/bash
# SessionStart hook for Claude Code on the web: install dependencies and build
# the WebUI so `npm run lint`, `npm run typecheck` and `npm test` work in a
# fresh cloud container (test/web-static.test.ts needs web/dist).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install --no-save --no-audit --no-fund
npm install --prefix web --no-save --no-audit --no-fund
npm --prefix web run build

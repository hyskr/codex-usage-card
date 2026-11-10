#!/bin/sh
set -eu

cd "$(dirname "$0")"
destination="$HOME/Library/Application Support/CodexUsageBadge"
agent="$HOME/Library/LaunchAgents/com.codexusagebadge.agent.plist"

if [ ! -f "$agent" ] || [ ! -f "$destination/agent.cjs" ]; then
  printf '%s\n' '请先安装 Codex Usage Badge 0.9.5。' >&2
  exit 1
fi

npm ci --no-audit --no-fund
npm run check
npm run build
install -m 600 badge-tokenizer.cjs "$destination/badge-tokenizer.cjs"
install -m 600 agent.cjs "$destination/agent.cjs"
launchctl kickstart -k "gui/$(id -u)/com.codexusagebadge.agent"
printf '%s\n' 'Codex Usage Badge 已更新。'

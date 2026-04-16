#!/bin/bash
# install.sh — Install Claude Chat Logger commands and scripts
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"

echo "Installing Claude Chat Logger..."

# Ensure directories exist
mkdir -p "${CLAUDE_DIR}/commands"
mkdir -p "${CLAUDE_DIR}/scripts"

# Copy commands
cp commands/session_record_start.md "${CLAUDE_DIR}/commands/"
cp commands/session_record_done.md "${CLAUDE_DIR}/commands/"
echo "  Installed commands: session_record_start, session_record_done"

# Copy scripts
cp scripts/session-finalize.mjs "${CLAUDE_DIR}/scripts/"
chmod +x "${CLAUDE_DIR}/scripts/session-finalize.mjs"
echo "  Installed scripts: session-finalize.mjs"

echo ""
echo "Done! Usage:"
echo "  1. In Claude Code, type /session_record_start"
echo "  2. Have your conversation"
echo "  3. Type /session_record_done to archive"

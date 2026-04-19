#!/bin/bash
# Auto-sync recipes: check for changes, convert & deploy if needed
WORKSPACE_RECIPES="/home/openclaw/.openclaw/workspace/recipes"
SITE_ROOT="/home/openclaw/.openclaw/workspace/projects/david-recipes"
SYNC_MARKER="$SITE_ROOT/.last-sync"
LOCK="/tmp/recipe-sync.lock"

# Prevent concurrent runs
exec 200>"$LOCK"
flock -n 200 || exit 0

# Check if any recipe file is newer than last sync
if [ -f "$SYNC_MARKER" ]; then
  NEWER=$(find "$WORKSPACE_RECIPES" -name "*.md" ! -name "README.md" -newer "$SYNC_MARKER" 2>/dev/null)
  if [ -z "$NEWER" ]; then
    exit 0
  fi
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Changes detected, syncing..."
node "$SITE_ROOT/scripts/sync-recipes.cjs" >> /tmp/openclaw/recipe-sync.log 2>&1
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Sync complete (exit $?)" >> /tmp/openclaw/recipe-sync.log

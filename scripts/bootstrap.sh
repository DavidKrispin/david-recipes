#!/usr/bin/env bash
# One-time setup: create the GitHub repo and push.
# Run this from /home/openclaw/.openclaw/workspace/projects/david-recipes
#
# Prereqs:
#   - gh CLI authenticated as a user/PAT with Administration:write on new repos
#   - Azure SWA deployment token already known (Chloe stored it)
#
set -euo pipefail

REPO="DavidKrispin/david-recipes"
SWA_TOKEN="8681336957a9fc75ff7b3b763d3d0d8b524f895a6f9b9bdd3c80f1d5e1092a4307-c425414c-eb87-412d-837e-400896050547003092002a2e3f03"

echo "==> Creating GitHub repo $REPO ..."
gh repo create "$REPO" --public \
  --description "Personal Hebrew RTL recipe site for David. Astro + Tailwind, deployed to Azure SWA." \
  --source=. --remote=origin --push

echo "==> Setting AZURE_STATIC_WEB_APPS_API_TOKEN secret ..."
gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo "$REPO" --body "$SWA_TOKEN"

echo "==> Done. Watch deployment:"
echo "    gh run watch --repo $REPO"
echo "==> Final URL:  https://purple-smoke-02a2e3f03.7.azurestaticapps.net"

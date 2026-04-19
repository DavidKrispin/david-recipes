#!/usr/bin/env bash
# scripts/buy-domain.sh
# Purchase ha-mitbach.com via Azure App Service Domains.
# Prerequisites:
#   1. Fill in .contact-info.json (copy from .contact-info.template.json) with real data:
#        address1, city, postal_code, state, phone (E.164 format like +972.501234567)
#   2. Be logged in to Azure (`az account show`).
# Cost: ~$11.99/year (charged to the active Azure subscription).

set -euo pipefail
RG=david-recipes-rg
DOMAIN=ha-mitbach.com
SWA=david-recipes
CONTACT=.contact-info.json

if [ ! -f "$CONTACT" ]; then
  echo "✗ $CONTACT not found. Copy .contact-info.template.json to .contact-info.json and fill it in." >&2
  exit 1
fi

if grep -q "FILL_ME" "$CONTACT"; then
  echo "✗ $CONTACT still contains FILL_ME placeholders. Edit it first." >&2
  exit 1
fi

echo "→ Reviewing legal terms..."
az appservice domain show-terms --hostname "$DOMAIN" || true

echo "→ Dry run (no purchase yet)..."
az appservice domain create -g "$RG" --hostname "$DOMAIN" --contact-info @"$CONTACT" --dryrun

read -rp "Proceed with actual purchase? (yes/no) " ans
[ "$ans" = "yes" ] || { echo "Aborted."; exit 0; }

echo "→ Purchasing $DOMAIN ..."
az appservice domain create -g "$RG" --hostname "$DOMAIN" --contact-info @"$CONTACT" --accept-terms

echo "→ Wiring custom domains to SWA $SWA ..."
az staticwebapp hostname set -n "$SWA" -g "$RG" --hostname "www.$DOMAIN"
az staticwebapp hostname set -n "$SWA" -g "$RG" --hostname "$DOMAIN"

echo "✓ Done. DNS may take 5–60 minutes to propagate. Verify:"
echo "   https://$DOMAIN"
echo "   https://www.$DOMAIN"

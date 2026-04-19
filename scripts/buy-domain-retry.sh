#!/bin/bash
# Try to purchase ha-mitbach.com - retry until subscription limit clears
cd /home/openclaw/.openclaw/workspace/projects/david-recipes

RESULT=$(az appservice domain create -g david-recipes-rg --hostname ha-mitbach.com --contact-info @.contact-info-azure.json --accept-terms --privacy 2>&1)

if echo "$RESULT" | grep -q "SubscriptionExceededMaxDomainLimit"; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Still waiting for quota to clear" >> /tmp/openclaw/domain-purchase.log
  exit 0
fi

if echo "$RESULT" | grep -q "error\|ERROR"; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Unexpected error: $RESULT" >> /tmp/openclaw/domain-purchase.log
  exit 1
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Domain purchased! Wiring DNS..." >> /tmp/openclaw/domain-purchase.log

# Create DNS zone if not auto-created
az network dns zone create -g david-recipes-rg -n ha-mitbach.com 2>/dev/null || true

# Wire custom domains to SWA
az staticwebapp hostname set -n david-recipes -g david-recipes-rg --hostname www.ha-mitbach.com 2>&1 >> /tmp/openclaw/domain-purchase.log
az staticwebapp hostname set -n david-recipes -g david-recipes-rg --hostname ha-mitbach.com 2>&1 >> /tmp/openclaw/domain-purchase.log

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DONE - ha-mitbach.com is live!" >> /tmp/openclaw/domain-purchase.log

# Remove this cron job
crontab -l | grep -v "buy-domain-retry" | crontab -

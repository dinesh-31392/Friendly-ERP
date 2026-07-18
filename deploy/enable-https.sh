#!/bin/sh
# Turn on HTTPS for Friendly CRM once your DNS A record points at this VPS.
#
#   ./deploy/enable-https.sh crm.yourdomain.com you@yourdomain.com
#
# What it does:
#   1. issues a Let's Encrypt certificate via the certbot service (webroot)
#   2. renders nginx.conf from nginx-https.conf.template with your domain
#      (a clean, complete HTTPS config — no fragile in-place editing)
#   3. validates it with `nginx -t` INSIDE the container and reloads ONLY if it
#      passes; otherwise it restores the previous config and stops
#
# Safe to re-run. It never reloads a config nginx itself rejects, and it keeps a
# backup of the working config.
set -eu

DOMAIN="${1:?usage: enable-https.sh <domain> <email>}"
EMAIL="${2:?usage: enable-https.sh <domain> <email>}"

cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.prod.yml"
CONF="nginx.conf"
TEMPLATE="nginx-https.conf.template"
BAK="nginx.conf.pre-https.bak"

[ -f "$TEMPLATE" ] || { echo "missing $TEMPLATE"; exit 1; }

echo "==> 1/4  Issuing certificate for $DOMAIN (HTTP server on :80 must be up)"
$COMPOSE run --rm certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email -n

echo "==> 2/4  Rendering HTTPS nginx config (backup: $BAK)"
cp "$CONF" "$BAK"
sed "s/__DOMAIN__/$DOMAIN/g" "$TEMPLATE" > "$CONF"

echo "==> 3/4  Validating with nginx -t"
$COMPOSE up -d web >/dev/null 2>&1 || true
if $COMPOSE exec -T web nginx -t; then
  echo "==> 4/4  Config OK — reloading nginx"
  $COMPOSE exec -T web nginx -s reload
  echo ""
  echo "✅ HTTPS is live at https://$DOMAIN"
  echo "   Now set PUBLIC_URL=https://$DOMAIN in .env and run: $COMPOSE up -d api"
  echo "   (the app also becomes installable once it's served over HTTPS)"
else
  echo "!! nginx rejected the rendered config — restoring $BAK, HTTP stays as-is."
  cp "$BAK" "$CONF"
  $COMPOSE exec -T web nginx -s reload || true
  echo "   The certificate WAS issued; check the domain and re-run."
  exit 1
fi

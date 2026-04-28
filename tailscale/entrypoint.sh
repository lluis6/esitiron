#!/bin/sh
set -e

# ── Arrancar el demonio de Tailscale ─────────────────────────
tailscaled \
    --state=/var/lib/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking \
    &
DAEMON_PID=$!

# Esperar a que el socket esté disponible
echo "⏳ Esperando a tailscaled..."
for i in $(seq 1 20); do
    tailscale --socket=/var/run/tailscale/tailscaled.sock status --json >/dev/null 2>&1 && break
    sleep 1
done

# ── Autenticar con la auth key ────────────────────────────────
echo "🔑 Autenticando en Tailscale..."
tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY}" \
    --hostname="${TS_HOSTNAME:-mi-app-tickets}" \
    --accept-routes

# ── Funnel público: app principal en 443 ─────────────────────
# "funnel" → accesible desde internet público
echo "🌍 Activando Funnel → http://localhost:80 ..."
tailscale --socket=/var/run/tailscale/tailscaled.sock funnel \
    --bg \
    --https=443 \
    http://localhost:80

# ── Serve privado: Grafana solo dentro del tailnet ────────────
# "serve" → SOLO accesible desde dispositivos en tu red Tailscale
# Apunta a Nginx que reenvía a Grafana via /grafana/
echo "📊 Activando Serve Grafana (solo tailnet) → http://localhost:80/grafana/ ..."
tailscale --socket=/var/run/tailscale/tailscaled.sock serve \
    --bg \
    --https=8443 \
    http://localhost:80

echo ""
echo "✅ Tailscale activo."
echo "   🌍 App (público):     https://${TS_HOSTNAME:-mi-app-tickets}.echo-theropod.ts.net"
echo ""
tailscale --socket=/var/run/tailscale/tailscaled.sock status
echo ""

wait $DAEMON_PID

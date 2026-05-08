#!/bin/sh
set -e

# ── 1. Arrancar el demonio de Tailscale ─────────────────────────
# Usamos userspace-networking porque estamos en un contenedor sin privilegios totales de kernel
tailscaled \
    --state=/var/lib/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking \
    &
DAEMON_PID=$!

# Esperar a que el socket de comunicación esté listo
echo "⏳ Esperando a que tailscaled esté listo..."
for i in $(seq 1 30); do
    if tailscale --socket=/var/run/tailscale/tailscaled.sock status --json >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# ── 2. Autenticar y levantar el nodo ───────────────────────────
echo "🔑 Autenticando en Tailscale con hostname: ${TS_HOSTNAME:-mi-app-tickets}..."
tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY}" \
    --hostname="${TS_HOSTNAME:-mi-app-tickets}" \
    --accept-routes \
    --accept-dns=true

# ── 3. Obtener la IP de Nginx dinámicamente ───────────────────
# Explicación: Tailscale funnel NO acepta el nombre "nginx_proxy", 
# por lo que extraemos su IP actual dentro de la red de Docker.
echo "🔍 Localizando contenedor de Nginx..."
NGINX_IP=$(getent hosts nginx_proxy | awk '{ print $1 }')

if [ -z "$NGINX_IP" ]; then
    echo "❌ ERROR: No se pudo encontrar la IP de 'nginx_proxy'. Revisa las redes en docker-compose."
    exit 1
fi
echo "📍 Nginx detectado en la IP: $NGINX_IP"

# ── 4. Configurar Funnel y Serve ─────────────────────────────

# "funnel" (Puerto 443) -> Abierto a todo Internet
echo "🌍 Activando Funnel público (443) -> http://$NGINX_IP:80 ..."
tailscale --socket=/var/run/tailscale/tailscaled.sock funnel \
    --bg \
    --https=443 \
    "http://$NGINX_IP:80"

# "serve" (Puerto 8443) -> Solo accesible por miembros de tu Tailnet
echo "📊 Activando Serve privado Grafana (8443) -> http://$NGINX_IP:80/grafana/ ..."
tailscale --socket=/var/run/tailscale/tailscaled.sock serve \
    --bg \
    --https=8443 \
    "http://$NGINX_IP:80"

# ── 5. Finalización y estado ──────────────────────────────────
echo ""
echo "✅ CONFIGURACIÓN COMPLETADA"
echo "──────────────────────────────────────────────────────"
echo "🌍 App Pública:  https://${TS_HOSTNAME:-mi-app-tickets}.echo-theropod.ts.net"
echo "📊 Grafana:      https://${TS_HOSTNAME:-mi-app-tickets}.echo-theropod.ts.net:8443"
echo "🗄️  ProxySQL:     Accesible internamente mediante 'proxysql:6033'"
echo "──────────────────────────────────────────────────────"
echo ""

# Mostrar el estado final para confirmar que el nodo está online
tailscale --socket=/var/run/tailscale/tailscaled.sock status

# Mantener el script vivo mientras el demonio tailscaled siga funcionando
wait $DAEMON_PID
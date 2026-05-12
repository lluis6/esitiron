# Esitiron - Plataforma de gestión de tiquets con OCR y monitorización

Stack dockerizado para subir tiquets (imagen/PDF), extraer productos con OCR + IA, validar resultados, y almacenar históricos con observabilidad completa.

## Visión general

Flujo funcional:
1. El usuario inicia sesión, sube un tiquet y lo revisa en la vista previa.
2. La app envía el archivo al OCR y recibe supermercado, fecha, total y líneas.
3. El usuario confirma, se persiste en MySQL y se alimenta el histórico.
4. El catálogo maestro y el diccionario mejoran la curación con el tiempo.

Puntos de entrada:
- Nginx hace de proxy inverso y aplica seguridad a rutas sensibles.
- La app web consume OCR y MySQL a través de ProxySQL.
- El stack de monitorización captura métricas y logs internos.

## Servicios y responsabilidades

Los servicios se orquestan en [docker-compose.yml](docker-compose.yml). Puertos expuestos al host:

| Servicio | Contenedor | Puerto host -> contenedor | Rol |
| --- | --- | --- | --- |
| Nginx | nginx_proxy | 8080 -> 80 | Entrada HTTP y seguridad |
| Grafana | grafana | 3001 -> 3000 | Dashboards y alertas |
| ProxySQL | proxysql | 6032/6033 -> 6032/6033 | Enrutamiento MySQL |

Servicios internos clave:
- web (Node.js): servidor principal, sesiones, 2FA, OCR, curación y métricas.
- ocr (FastAPI): endpoint /analizar, soporte imagen/PDF, Gemini con rotación de claves.
- db (MySQL master) y db_replica (MySQL read-only).
- prometheus, loki, promtail y exporters (node, nginx, mysql, cadvisor).
- socket-proxy: proxy seguro al socket de Docker para promtail/cAdvisor.
- tailscale y cloudflared: exposición externa controlada.

Redes Docker:
- red_publica: tráfico de entrada (proxy, tailscale, cloudflared).
- red_interna: base de datos y ProxySQL (internal).
- red_procesamiento: web y ocr (internal).
- red_ia: tráfico del OCR.
- red_monitoring: observabilidad.

## Seguridad y acceso

Reglas destacadas en [nginx.conf](nginx.conf):
- Rate limiting en /login y /login/2fa.
- /metrics y /avatars bloqueados desde fuera.
- /avatar/ se sirve desde la app con caché segura.
- Proxy CORS para OpenFoodFacts en /api/openfoodfacts/.

En la app ([web/server.js](web/server.js)):
- Cookies seguras cuando NODE_ENV=production.
- Cifrado AES-256-GCM para datos sensibles con SESSION_SECRET y AES_SALT.
- Directorio de avatares configurable con AVATARS_DIR.

## Variables de entorno (.env)

El archivo [.env](.env) se usa por varios servicios. No lo subas al repo.

Base de datos:
- DB_ROOT_PASSWORD
- DB_NAME
- DB_USER
- DB_PASSWORD

ProxySQL:
- DB_USER_PROXY
- DB_PASSWORD_PROXY
- PROXYSQL_ADMIN_USER
- PROXYSQL_ADMIN_PASSWORD
- PROXYSQL_ADMIN_RO_USER
- PROXYSQL_ADMIN_RO_PASSWORD
- PROXYSQL_MONITOR_USER
- PROXYSQL_MONITOR_PASSWORD

App web:
- SESSION_SECRET (openssl rand -base64 64)
- AES_SALT (openssl rand -hex 32)
- NODE_ENV (production recomendado)
- AVATARS_DIR (opcional)

OCR (Gemini):
- CLAVE_1..CLAVE_10 (rotación)
- CLAVE_API (fallback)

OpenFoodFacts (opcional):
- OFF_SEARCH_URL, OFF_SECONDARY_URL, OFF_FALLBACK_URL, OFF_TIMEOUT_MS
- OPF_BASE_URL, OPF_LOOKUP_PATH, OPF_CREATE_PATH, OPF_IMAGE_PATH
- OPF_TIMEOUT_MS, OPF_USER_ID, OPF_PASSWORD, OPF_USER_AGENT
- OPENFACTS_API_KEY

Monitorización:
- GF_ADMIN_USER
- GF_ADMIN_PASSWORD

Conectividad externa:
- TAILSCALE_AUTHKEY
- TS_HOSTNAME
- CLOUDFLARE_TUNNEL_TOKEN

## Operación diaria

Requisitos:
- Docker + Docker Compose

Arranque inicial:
~~~bash
cd /home/esitiron/docker_containers
docker compose up -d --build
~~~

Estado y logs:
~~~bash
docker compose ps
docker compose logs -f
docker compose logs -f web
docker compose logs -f ocr
docker compose logs -f proxy
~~~

Reinicios y apagado:
~~~bash
docker compose restart web
docker compose stop
docker compose start
docker compose down
docker compose down -v  # destructivo
~~~

Salud rápida:
~~~bash
curl -s http://localhost:8080/health
docker compose exec prometheus wget -qO- http://localhost:9090/-/healthy
docker compose exec grafana wget -qO- http://localhost:3000/api/health
~~~

## Datos y replicación

Esquema base en [db_base/schema.sql](db_base/schema.sql). La app aplica pequeñas migraciones en arranque.

Replica y failover:
- db_replica ejecuta [monitoring/scripts/sql/auto_promote.sh](monitoring/scripts/sql/auto_promote.sh) para promoción automática si cae el master.
- ProxySQL decide lecturas/escrituras según [proxysql.cnf](proxysql.cnf).

Acceso SQL manual:
~~~bash
docker compose exec db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
~~~

Migraciones manuales (si aplica):
~~~bash
docker compose exec -T db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < migration_curacion.sql
~~~

## Backups y mantenimiento

Backup automatizado:
- Script en [monitoring/scripts/backup/backup_esitiron.sh](monitoring/scripts/backup/backup_esitiron.sh).
- Requiere el disco externo montado en /home/esitiron/external_disk.
- Guarda copias en /home/esitiron/external_disk/copias/ y rota > 30 días.

Control de CPU OCR:
- Script en [monitoring/scripts/cpu/cpu_watchdog.sh](monitoring/scripts/cpu/cpu_watchdog.sh).
- Limita CPU del contenedor ocr_ia cuando hay picos.

## Observabilidad

Prometheus scrapea web, mysql-exporter, nginx-exporter, node-exporter y cadvisor. Config en [monitoring/prometheus/prometheus.yml](monitoring/prometheus/prometheus.yml).

Grafana provisiona datasources en [monitoring/grafana/provisioning/datasources/prometheus.yml](monitoring/grafana/provisioning/datasources/prometheus.yml).

Loki/Promtail gestionan logs en [monitoring/loki/config.yml](monitoring/loki/config.yml) y [monitoring/promtail/config.yml](monitoring/promtail/config.yml).

## Conectividad externa

Tailscale se configura en [tailscale/entrypoint.sh](tailscale/entrypoint.sh):
- Funnel publica la app.
- Serve expone Grafana de forma privada.

Cloudflared usa CLOUDFLARE_TUNNEL_TOKEN para el tunnel.

## Estructura rápida

~~~text
.
|- docker-compose.yml
|- nginx.conf
|- proxysql.cnf
|- db_base/
|  |- schema.sql
|- ocr/
|  |- main.py
|- web/
|  |- server.js
|- monitoring/
|  |- prometheus/
|  |- grafana/
|  |- loki/
|  |- promtail/
|  |- scripts/
|- tailscale/
|  |- requirements.txt
|  |- Dockerfile
|- web/
|  |- server.js
|  |- package.json
|  |- views/
|  |- public/
|- monitoring/
|  |- prometheus/prometheus.yml
|  |- grafana/provisioning/datasources/prometheus.yml
|  |- loki/config.yml
|  |- promtail/config.yml
|- tailscale/
|  |- entrypoint.sh
~~~

## 9. Observaciones Técnicas

- OCR integra limpieza/normalización y guarda nombre_ocr para alimentar el diccionario de curación.
- La vinculación de productos puede consolidar históricos y limpiar maestros temporales.
- OpenFoodFacts tiene fallback multi-origen para mejorar resiliencia cuando hay respuestas HTML/503.
- /avatars/ directo está bloqueado en Nginx; la entrega segura se hace por /avatar/:filename validando sesión.
- Grafana no tiene puerto publicado al host por diseño de seguridad.

---
Si quieres, en un siguiente paso puedo añadir también un .env.example limpio y una sección de troubleshooting por errores típicos (OCR, DB charset, timeouts OFF, permisos Docker).

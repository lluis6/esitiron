# Esitiron - Plataforma de Gestion de Tiquets con OCR, Curacion y Monitorizacion

Proyecto dockerizado para:
- Subir tiquets (imagen/PDF)
- Extraer productos con OCR + IA (Gemini)
- Editar y confirmar resultados antes de guardar
- Curar productos contra un catalogo maestro
- Comparar precios historicos por supermercado
- Gestionar usuarios con 2FA
- Monitorizar infraestructura y logs con Prometheus, Grafana, Loki y Promtail

## 1. Vision General

La entrada publica pasa por Nginx y desde ahi se reenvia al servicio web. El backend web guarda datos en MySQL y llama al servicio OCR para procesar tiquets. A la vez, el stack de monitorizacion recoge metricas y logs internos.

Flujo principal:
1. Usuario inicia sesion o se registra.
2. Sube un tiquet en la pantalla de dashboard.
3. El servicio web envia el archivo al OCR en /analizar.
4. OCR devuelve supermercado, fecha, total y lineas de producto.
5. Usuario revisa/edita en preview y confirma.
6. Se persiste en MySQL (tiquets, compras, historial_precios, etc.).
7. En productos, el usuario puede vincular productos OCR a un maestro para mejorar la calidad global.

## 2. Componentes del Proyecto

### Infraestructura y entrada
- docker-compose.yml
  - Orquesta toda la plataforma: app, OCR, DB, proxy, monitorizacion y conectividad externa.
- nginx.conf
  - Proxy inverso hacia web.
  - Bloquea acceso directo a /avatars/.
  - Sirve /avatar/:filename solo via backend autenticado.
  - Expone un proxy CORS para OpenFoodFacts en /api/openfoodfacts/.

### Aplicacion web (Node.js + Express + Nunjucks)
Carpeta: web/

Archivos clave:
- server.js
  - Backend principal en produccion (el que ejecuta Dockerfile).
  - Login/registro, sesiones, perfil, avatar, 2FA, carga de tiquets, preview, guardado, curacion, votaciones de barcode, endpoints API y /metrics.
- package.json
  - Scripts start/dev y dependencias.
- views/
  - Plantillas de interfaz (dashboard, login, perfil, preview, detalle, listados).
- public/
  - CSS, JS y recursos estaticos.

Notas:
- web/index.js parece una version anterior/no usada por docker-compose actual.
- web/metrics.js existe, pero server.js ya publica /metrics directamente.

### OCR (Python + FastAPI + Gemini)
Carpeta: ocr/

Archivos clave:
- main.py
  - Endpoint POST /analizar.
  - Soporta imagen y PDF (pdf2image).
  - Usa google-genai con rotacion de claves CLAVE_1..CLAVE_10.
  - Normaliza categorias y nombres, y conserva nombre_ocr para aprendizaje posterior.
- requirements.txt
  - FastAPI, OpenCV, Pillow, numpy, google-genai, etc.

### Base de datos
- db_base/schema.sql
  - Esquema inicial completo (usuarios, tiquets, compras, productos_maestros, historial, 2FA, diccionario, verificaciones).
- migration_curacion.sql
  - Migracion adicional de curacion y vista auxiliar.

### Monitorizacion
Carpeta: monitoring/
- prometheus/prometheus.yml
  - Targets: prometheus, web (/metrics), node-exporter, cadvisor, mysql-exporter, nginx-exporter.
- grafana/provisioning/datasources/prometheus.yml
  - Datasources provisionadas: Prometheus y Loki.
- loki/config.yml
  - Almacenamiento local de logs.
- promtail/config.yml
  - Descubre contenedores Docker y envia logs a Loki.

### Conectividad externa
- tailscale/entrypoint.sh
  - Levanta tailscaled y configura funnel/serve.
- cloudflared (en compose)
  - Ejecuta tunnel run con token.

## 3. Servicios de Docker Compose

Servicios principales:
- proxy (Nginx): puerto 80 publicado al host.
- web (Node.js): no publica puerto directamente al host (acceso via proxy).
- ocr (FastAPI): interno.
- db (MySQL 8): interno.
- tailscale / cloudflared: conectividad externa.
- prometheus / grafana / loki / promtail + exporters: observabilidad interna.

Redes:
- red_publica
- red_interna (internal)
- red_procesamiento (internal)
- red_ia
- red_monitoring

## 4. Variables de Entorno Importantes

En .env debes definir, al menos:

Base de datos:
- DB_ROOT_PASSWORD
- DB_PASSWORD
- DB_USER
- DB_NAME

OCR/Gemini:
- CLAVE_1..CLAVE_10 (o CLAVE_API como fallback)

Seguridad y app:
- SESSION_SECRET
- NODE_ENV

Conectividad:
- TAILSCALE_AUTHKEY
- TS_HOSTNAME
- CLOUDFLARE_TUNNEL_TOKEN

Monitorizacion:
- GF_ADMIN_USER
- GF_ADMIN_PASSWORD
- METRICS_PORT

ProxySQL + failover:
- PROXYSQL_ADMIN_USER
- PROXYSQL_ADMIN_PASSWORD
- PROXYSQL_MONITOR_USER
- PROXYSQL_MONITOR_PASSWORD
- PROXYSQL_STATS_USER (opcional, por defecto igual a PROXYSQL_ADMIN_USER)
- PROXYSQL_STATS_PASSWORD (opcional, por defecto igual a PROXYSQL_ADMIN_PASSWORD)
- PROXYSQL_PORT (opcional, por defecto 3306)
- PROXYSQL_ADMIN_PORT (opcional, por defecto 6032)
- REPLICATION_USER
- REPLICATION_PASSWORD
- FAILOVER_CHECK_INTERVAL (opcional, segundos)
- FAILOVER_AUTO_REJOIN (opcional, true/false)
- FAILOVER_ENABLED (opcional, true/false)

Recomendado:
- No subir .env al repositorio.
- Rotar cualquier credencial que haya quedado expuesta.

## 5. Comandos Basicos de Uso

## Requisitos
- Docker
- Docker Compose (plugin docker compose)

## Arranque inicial
~~~bash
cd /home/lluis/esitiron/docker_cont_new
docker compose up -d --build
~~~

## Ver estado
~~~bash
docker compose ps
~~~

## Ver logs
~~~bash
# Todos
docker compose logs -f

# Solo aplicacion web
docker compose logs -f web

# Solo OCR
docker compose logs -f ocr

# Solo proxy
docker compose logs -f proxy
~~~

## Reiniciar un servicio
~~~bash
docker compose restart web
~~~

## Parar y arrancar sin reconstruir
~~~bash
docker compose stop
docker compose start
~~~

## Apagar todo
~~~bash
docker compose down
~~~

## Apagar y borrar tambien volumenes (destructivo)
~~~bash
docker compose down -v
~~~

## Aplicar migracion manual (si necesitas migration_curacion.sql)
~~~bash
cd /home/lluis/esitiron/docker_cont_new
docker compose exec -T db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < migration_curacion.sql
~~~

## Entrar a MySQL
~~~bash
docker compose exec db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
~~~

## Comprobaciones rapidas
~~~bash
# Salud de la app (via Nginx)
curl -s http://localhost/health

# Salud de Prometheus (interno desde su contenedor)
docker compose exec prometheus wget -qO- http://localhost:9090/-/healthy

# Salud de Grafana (interno desde su contenedor)
docker compose exec grafana wget -qO- http://localhost:3000/api/health
~~~

## 6. Uso Funcional Basico de la App

1. Abrir en navegador: http://localhost
2. Registrar usuario (o iniciar sesion).
3. Subir un tiquet (JPG/PNG/WEBP/GIF/PDF).
4. Revisar en preview y editar lineas si hace falta.
5. Confirmar para guardar.
6. Consultar:
   - Dashboard: resumen y KPIs.
   - Tiquets: historico completo y detalle.
   - Productos: filtros, vinculacion de maestros, comparativa de precios, votaciones de barcode.
7. En Perfil: actualizar datos, avatar y activar/desactivar 2FA.

## 7. Endpoints Relevantes

Publicos (via proxy):
- GET /health
- GET /login
- POST /login
- GET /dashboard (requiere sesion)
- POST /subir_tiquet (requiere sesion)
- GET /preview (requiere sesion)
- POST /confirmar (requiere sesion)
- GET /productos (requiere sesion)
- GET /metrics

APIs internas de la app (requieren sesion):
- GET /api/proxy/off?q=...
- GET /api/maestros/buscar?q=...
- POST /api/compras/vincular
- POST /api/verificaciones/votar
- POST /api/compra/:idCompra/precio
- GET /api/producto/:id/precios

Proxy OpenFoodFacts (Nginx):
- /api/openfoodfacts/...

## 8. Estructura Resumida

~~~text
.
|- docker-compose.yml
|- nginx.conf
|- migration_curacion.sql
|- db_base/
|  |- schema.sql
|- ocr/
|  |- main.py
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

## 9. Observaciones Tecnicas

- OCR integra limpieza/normalizacion y guarda nombre_ocr para alimentar el diccionario de curacion.
- La vinculacion de productos puede consolidar historicos y limpiar maestros temporales.
- OpenFoodFacts tiene fallback multi-origen para mejorar resiliencia cuando hay respuestas HTML/503.
- /avatars/ directo esta bloqueado en Nginx; la entrega segura se hace por /avatar/:filename validando sesion.
- Grafana no tiene puerto publicado al host por diseno de seguridad.

## 10. ProxySQL + Replicacion MySQL (failover)

### 10.1 Requisitos previos
- La config de MySQL ya activa GTID y binlog en master y replica via docker-compose.
- Si ya tienes volúmenes con datos antiguos, puede ser necesario reiniciar los volúmenes para aplicar GTID (esto borra datos).

### 10.2 Crear usuarios necesarios
En el master (db):
~~~bash
docker compose exec db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "CREATE USER IF NOT EXISTS '\''$REPLICATION_USER'\''@'\''%'\'' IDENTIFIED BY '\''$REPLICATION_PASSWORD'\''; GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '\''$REPLICATION_USER'\''@'\''%'\''; FLUSH PRIVILEGES;"'
docker compose exec db sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "CREATE USER IF NOT EXISTS '\''$PROXYSQL_MONITOR_USER'\''@'\''%'\'' IDENTIFIED BY '\''$PROXYSQL_MONITOR_PASSWORD'\''; GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO '\''$PROXYSQL_MONITOR_USER'\''@'\''%'\''; FLUSH PRIVILEGES;"'
~~~
Nota: en MySQL 8.0.22+ puedes usar `REPLICATION REPLICA` como sinónimo de `REPLICATION SLAVE`.

### 10.3 Inicializar la replica desde snapshot
1) Genera un dump del master:
~~~bash
docker compose exec -T db sh -lc 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction --set-gtid-purged=ON "$MYSQL_DATABASE"' > /tmp/master_dump.sql
~~~
2) Restaura en la replica:
~~~bash
docker compose exec -T db_replica sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < /tmp/master_dump.sql
~~~
3) Configura la replica (GTID):
~~~bash
docker compose exec db_replica sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='\''db'\'', SOURCE_USER='\''$REPLICATION_USER'\'', SOURCE_PASSWORD='\''$REPLICATION_PASSWORD'\'', SOURCE_AUTO_POSITION=1; START REPLICA;"'
~~~
4) Verifica estado:
~~~bash
docker compose exec db_replica sh -lc 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "SHOW REPLICA STATUS\\G"'
~~~

### 10.4 ProxySQL y conexion de la app
- La app ya apunta a ProxySQL con DB_HOST=proxysql.
- ProxySQL escucha en 3306 dentro de red interna (configurable con PROXYSQL_PORT).
- Reads se enrutan a la replica (SELECT) y writes al master.

### 10.5 Failover automatico (script)
El servicio `failover-manager`:
- Detecta caida del master y promueve la replica.
- Si `FAILOVER_AUTO_REJOIN=true`, reengancha el master recuperado como replica del nuevo primario.

Para cambiar el primario de vuelta al master original (failback completo), hazlo manualmente:
1) Fuerza read_only en el primario actual y promueve el master original.
2) Reconfigura la replica con `CHANGE REPLICATION SOURCE TO ... SOURCE_AUTO_POSITION=1`.

Si tienes `general_log` activado, los comandos de replicación pueden quedar registrados; mantenlo desactivado en producción.

### 10.6 Monitorizacion de lag y estado
- Prometheus scrapea `mysql-exporter-replica` para exponer lag y estado de replica.
- Métricas útiles: `mysql_slave_status_seconds_behind_master`, `mysql_slave_status_slave_io_running`, `mysql_slave_status_slave_sql_running`.

---
Si quieres, en un siguiente paso puedo anadir tambien un .env.example limpio y una seccion de troubleshooting por errores tipicos (OCR, DB charset, timeouts OFF, permisos Docker).

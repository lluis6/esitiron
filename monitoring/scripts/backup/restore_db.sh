#!/bin/bash

# CONFIGURACIÓN DE RUTAS
DOCKER_DIR="/home/esitiron/docker_containers"
ENV_FILE="$DOCKER_DIR/.env"
BACKUP_ROOT="/home/esitiron/external_disk/copias"
LOG_FILE="/home/esitiron/external_disk/copias/import_db.log"

# Contenedor master definido en tu docker-compose
CONTAINER_MASTER="db_mysql"

echo "==========================================" >> "$LOG_FILE"
echo "[$(date)] Iniciando proceso de restauración como ROOT..." >> "$LOG_FILE"

# 1. Verificar si el disco externo está montado
if ! mountpoint -q /home/esitiron/external_disk; then
    echo "[$(date)] ERROR: El disco externo no está montado. Abortando." >> "$LOG_FILE"
    exit 1
fi

# 2. Cargar credenciales desde .env
if [ -f "$ENV_FILE" ]; then
    # Cargamos el archivo .env
    export $(grep -v '^#' "$ENV_FILE" | xargs)
    echo "[$(date)] OK: Variables cargadas desde .env" >> "$LOG_FILE"
else
    echo "[$(date)] ERROR: No se encontró el archivo .env en $ENV_FILE" >> "$LOG_FILE"
    exit 1
fi

# 3. Buscar el backup SQL comprimido más reciente
LATEST_BACKUP=$(find "$BACKUP_ROOT" -type f -name "*.sql.gz" -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)

if [ -z "$LATEST_BACKUP" ]; then
    echo "[$(date)] ERROR: No se encontró ningún archivo .sql.gz" >> "$LOG_FILE"
    exit 1
fi

echo "[$(date)] OK: Backup detectado -> $LATEST_BACKUP" >> "$LOG_FILE"
echo "Restaurando archivo: $LATEST_BACKUP"

# 4. Restaurar la base de datos USANDO ROOT
# Cambiamos -u"${DB_USER}" por -u"root" 
# y -p"${DB_PASSWORD}" por -p"${DB_ROOT_PASSWORD}"
zcat "$LATEST_BACKUP" | docker exec -i "$CONTAINER_MASTER" mysql -u"root" -p"${DB_ROOT_PASSWORD}" "${DB_NAME}"

# 5. Comprobación final
if [ $? -eq 0 ]; then
    echo "[$(date)] ÉXITO: Importación completada con ROOT en '$DB_NAME'." >> "$LOG_FILE"
    echo "¡Restauración completada con éxito!"
else
    echo "[$(date)] ERROR: Fallo crítico en la importación incluso con ROOT." >> "$LOG_FILE"
    echo "Revisa que DB_ROOT_PASSWORD en el .env sea correcta."
    exit 1
fi

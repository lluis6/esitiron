#!/bin/bash

# EXTRAER VERSIÓN DE GIT
VERSION_GIT=$(git -C "/home/esitiron/docker_containers" log -1 --format="%s" | sed 's/.*: //' | xargs)
VERSION_GIT=${VERSION_GIT:-"version-desconocida"}

# CONFIGURACIÓN DE RUTAS
FECHA=$(date +"%Y-%m-%d_%H-%M")
DOCKER_DIR="/home/esitiron/docker_containers"
ENV_FILE="$DOCKER_DIR/.env"

# Ruta base con el nombre de la versión
BACKUP_BASE="/home/esitiron/external_disk/copias/$VERSION_GIT"

# Subcarpetas específicas
BACKUP_DB="$BACKUP_BASE/Backups_DB"
BACKUP_DOCKER="$BACKUP_BASE/Backups_Docker"

# El log lo mantenemos en la raíz de copias para tener un historial global
LOG_FILE="/home/esitiron/external_disk/copias/backup.log"

# CREACIÓN DE CARPETAS (si no existe)
mkdir -p "$BACKUP_DB"
mkdir -p "$BACKUP_DOCKER"

# CARGAR VARIABLES DESDE .env
if [ -f "$ENV_FILE" ]; then
    # Exporta las variables del .env
    export $(grep -v '^#' "$ENV_FILE" | xargs)
    echo "[$(date)] Variables cargadas correctamente desde .env" >> $LOG_FILE
else
    echo "[$(date)] ERROR: No se encontró el archivo .env en $ENV_FILE" >> $LOG_FILE
    exit 1
fi

# CONFIGURACIÓN DE VARIABLES
DB_USER=${DB_USER}
DB_PASS=${DB_PASSWORD}
DB_NAME=${DB_NAME}
CONTAINER_BD="db_mysql"

# Archivos de salida
ARCHIVO_SQL="$BACKUP_DB/db_${DB_NAME}_$FECHA.sql.gz"
ARCHIVO_DOCKER="$BACKUP_DOCKER/docker_files_$FECHA.tar.gz"

# INICIO DEL PROCESO
echo "[$(date)] Iniciando backup..." >> $LOG_FILE

# Verificar disco externo
if ! mountpoint -q /home/esitiron/external_disk; then
    echo "[$(date)] ERROR: El disco externo no está montado." >> $LOG_FILE
    exit 1
fi

# Backup de Base de Datos
echo "Extrayendo base de datos $DB_NAME..."
docker exec -i "$DB_CONTAINER" /usr/bin/mysqldump -u"$USER_BD" -p"$PASS_BD" "$NAME_BD" 2>/dev/null | gzip > "$ARCHIVO_SQL"

if [ $? -eq 0 ]; then
    echo "[$(date)] DB Backup OK: $ARCHIVO_SQL" >> $LOG_FILE
else
    echo "[$(date)] ERROR en el backup de la DB" >> $LOG_FILE
fi

# Backup de archivos Docker
echo "Comprimiendo archivos de Docker..."
tar -czf "$ARCHIVO_DOCKER" --exclude='node_modules' --exclude='.*' -C "$DOCKER_DIR" .

if [ $? -eq 0 ]; then
    echo "[$(date)] Docker Files Backup OK: $ARCHIVO_DOCKER" >> $LOG_FILE
else
    echo "[$(date)] ERROR en el backup de archivos Docker" >> $LOG_FILE
fi

# Limpieza de archivos de más de 30 días
find "/home/esitiron/external_disk/copias" -type f -name "*.gz" -mtime +30 -delete >> "$LOG_FILE" 2>&1

echo "[$(date)] Backup finalizado." >> "$LOG_FILE"
echo "------------------------------------------" >> "$LOG_FILE"
#!/bin/bash

# --- CONFIGURACIÓN DE RUTAS ---
DOCKER_DIR="/home/esitiron/docker_containers"
ENV_FILE="$DOCKER_DIR/.env"

# 1. Cargar variables desde el .env
if [ -f "$ENV_FILE" ]; then
    # Usamos export para que las variables estén disponibles en el script
    export $(grep -v '^#' "$ENV_FILE" | xargs)
else
    echo "$(date): ERROR: No se encontró el archivo .env en $ENV_FILE"
    exit 1
fi

# 2. Asignar variables del .env a nombres internos
# Usamos DB_ROOT_PASSWORD que suele ser la de root en tus archivos
USER="root"
PASS="${DB_ROOT_PASSWORD}" 
MASTER_HOST="db_mysql"

# Intentamos un ping al puerto 3306
if ! (echo > /dev/tcp/$MASTER_HOST/3306) >/dev/null 2>&1; then
    echo "$(date): Master caído detectado."
    
    # Ejecutamos la promoción directamente
    # Quitamos el read_only y el super_read_only para que ProxySQL lo vea
    mysql -u$USER -p"$PASS" -e "SET GLOBAL read_only=0; SET GLOBAL super_read_only=0; STOP SLAVE;" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "$(date): ¡Promoción exitosa! Ahora soy Master."
    else
        echo "$(date): Error intentando promocionar. Revisa credenciales."
    fi
else
    echo "$(date): Master saludable."
fi
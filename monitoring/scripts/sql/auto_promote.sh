#!/bin/bash

# Forzamos las variables por si el .env falla
USER="root"
PASS="wdyb54" # Pon tu password real aquí directamente para asegurar
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
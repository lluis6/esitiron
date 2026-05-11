#!/bin/bash

# Usamos las variables que ya tiene el contenedor
USER="root"
PASS="${MYSQL_ROOT_PASSWORD}" 
MASTER_HOST="db_mysql"

echo "$(date): Comprobando estado del Master ($MASTER_HOST)..."
# Intentamos conectar 3 veces antes de darlo por muerto
for i in {1..3}; do
    if (echo > /dev/tcp/$MASTER_HOST/3306) >/dev/null 2>&1; then
        echo "$(date): Master saludable."
        exit 0
    fi
    echo "$(date): Intento $i: No responde, reintentando..."
    sleep 2
done
echo "$(date): Master caído confirmado tras 3 intentos. Iniciando promoción..."

# Promoción real
mysql -u$USER -p"$PASS" -e "SET GLOBAL read_only=0; SET GLOBAL super_read_only=0; STOP SLAVE;"
if [ $? -eq 0 ]; then
    echo "$(date): ¡Promoción exitosa! Ahora soy Master."
    # IMPORTANTE: Avisamos a ProxySQL forzando un cambio que detecte
else
    echo "$(date): Error en la promoción."
fi
#!/bin/bash

# --- CONFIGURACIÓN ---
UMBRAL_CRITICO=90    # Porcentaje de CPU total para actuar
CPU_LIMIT_REDUCIDO="0.5" # Límite de emergencia (medio core)
CPU_LIMIT_NORMAL="2.0"   # Potencia máxima habitual (ajústalo a tu servidor)
CONTENEDOR_DIANA="ocr_ia" # El contenedor que suele causar los picos
LOG_FILE="/home/esitiron/docker_containers/monitoring/scripts/cpu/cpu_watchdog.log"

echo "[$(date)] Vigilante iniciado. Umbral: $UMBRAL_CRITICO%" >> "$LOG_FILE"

ESTADO="NORMAL"

while true; do
    # 1. Obtener la carga total de CPU (promedio de todos los cores)
    # Usamos 'top' para sacar el porcentaje de uso real
    CPU_TOTAL=$(top -bn1 | grep "Cpu(s)" | awk '{print 100 - $8}')
    CPU_INT=${CPU_TOTAL%.*} # Convertir a número entero

    # 2. Lógica de actuación
    if [ "$CPU_INT" -gt "$UMBRAL_CRITICO" ] && [ "$ESTADO" == "NORMAL" ]; then
        echo "[$(date)] ALERTA: CPU al $CPU_INT%. Aplicando freno de mano a $CONTENEDOR_DIANA..." >> "$LOG_FILE"
        
        # Limitamos el contenedor sin detenerlo
        docker update --cpus "$CPU_LIMIT_REDUCIDO" "$CONTENEDOR_DIANA"
        ESTADO="LIMITADO"

    elif [ "$CPU_INT" -lt 60 ] && [ "$ESTADO" == "LIMITADO" ]; then
        # Solo devolvemos la potencia si la CPU ha bajado significativamente (evita rebotes)
        echo "[$(date)] OK: CPU recuperada ($CPU_INT%). Restaurando potencia a $CONTENEDOR_DIANA." >> "$LOG_FILE"
        
        docker update --cpus "$CPU_LIMIT_NORMAL" "$CONTENEDOR_DIANA"
        ESTADO="NORMAL"
    fi

    sleep 10 # Revisar cada 10 segundos
done
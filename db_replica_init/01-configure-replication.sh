#!/bin/bash
set -euo pipefail

master_host="${DB_MASTER_HOST:-db}"
master_port="${DB_MASTER_PORT:-3306}"

if [[ -z "${DB_REPL_USER:-}" || -z "${DB_REPL_PASSWORD:-}" ]]; then
  echo "[replica-init] DB_REPL_USER/DB_REPL_PASSWORD no definidos. No se puede configurar replicación." >&2
  exit 1
fi

echo "[replica-init] Esperando a que el master (${master_host}:${master_port}) esté disponible..."
until mysqladmin ping -h "${master_host}" -P "${master_port}" -u "${DB_REPL_USER}" -p"${DB_REPL_PASSWORD}" --silent; do
  sleep 2
done

mysql --force -u root -p"${MYSQL_ROOT_PASSWORD}" <<-EOSQL
  STOP REPLICA;
  RESET REPLICA ALL;
  CHANGE REPLICATION SOURCE TO
    SOURCE_HOST='${master_host}',
    SOURCE_PORT=${master_port},
    SOURCE_USER='${DB_REPL_USER}',
    SOURCE_PASSWORD='${DB_REPL_PASSWORD}',
    SOURCE_AUTO_POSITION=1,
    SOURCE_CONNECT_RETRY=5;
  START REPLICA;
EOSQL

echo "[replica-init] Replicación configurada contra ${master_host}:${master_port}."

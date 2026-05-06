#!/bin/bash
set -euo pipefail

mysql=(mysql -u root -p"${MYSQL_ROOT_PASSWORD}")

if [[ -n "${DB_REPL_USER:-}" && -n "${DB_REPL_PASSWORD:-}" ]]; then
  "${mysql[@]}" <<-EOSQL
    CREATE USER IF NOT EXISTS '${DB_REPL_USER}'@'%' IDENTIFIED BY '${DB_REPL_PASSWORD}';
    GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '${DB_REPL_USER}'@'%';
    FLUSH PRIVILEGES;
EOSQL
else
  echo "[init] DB_REPL_USER/DB_REPL_PASSWORD no definidos, se omite usuario de replicación." >&2
fi

if [[ -n "${ORC_USER:-}" && -n "${ORC_PASSWORD:-}" ]]; then
  "${mysql[@]}" <<-EOSQL
    CREATE DATABASE IF NOT EXISTS orchestrator;
    CREATE USER IF NOT EXISTS '${ORC_USER}'@'%' IDENTIFIED BY '${ORC_PASSWORD}';
    GRANT ALL PRIVILEGES ON orchestrator.* TO '${ORC_USER}'@'%';
    GRANT SUPER, PROCESS, REPLICATION SLAVE, REPLICATION CLIENT, RELOAD ON *.* TO '${ORC_USER}'@'%';
    FLUSH PRIVILEGES;
EOSQL
else
  echo "[init] ORC_USER/ORC_PASSWORD no definidos, se omite usuario de Orchestrator." >&2
fi

monitor_user="${PROXYSQL_MONITOR_USER:-${DB_REPL_USER:-}}"
monitor_password="${PROXYSQL_MONITOR_PASSWORD:-${DB_REPL_PASSWORD:-}}"
if [[ -n "${monitor_user}" && -n "${monitor_password}" ]]; then
  "${mysql[@]}" <<-EOSQL
    CREATE USER IF NOT EXISTS '${monitor_user}'@'%' IDENTIFIED BY '${monitor_password}';
    GRANT REPLICATION CLIENT ON *.* TO '${monitor_user}'@'%';
    FLUSH PRIVILEGES;
EOSQL
else
  echo "[init] PROXYSQL_MONITOR_USER/PROXYSQL_MONITOR_PASSWORD no definidos, se omite usuario monitor." >&2
fi

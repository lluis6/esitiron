#!/bin/sh
set -eu

: "${DB_USER:?DB_USER requerido}"
: "${DB_PASSWORD:?DB_PASSWORD requerido}"
: "${DB_REPL_USER:?DB_REPL_USER requerido}"
: "${DB_REPL_PASSWORD:?DB_REPL_PASSWORD requerido}"

export PROXYSQL_ADMIN_USER="${PROXYSQL_ADMIN_USER:-admin}"
export PROXYSQL_ADMIN_PASSWORD="${PROXYSQL_ADMIN_PASSWORD:-admin}"
export PROXYSQL_MONITOR_USER="${PROXYSQL_MONITOR_USER:-$DB_REPL_USER}"
export PROXYSQL_MONITOR_PASSWORD="${PROXYSQL_MONITOR_PASSWORD:-$DB_REPL_PASSWORD}"

envsubst < /etc/proxysql/proxysql.cnf.template > /etc/proxysql/proxysql.cnf

exec proxysql -f -c /etc/proxysql/proxysql.cnf

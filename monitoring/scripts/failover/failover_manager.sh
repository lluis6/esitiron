#!/bin/sh
set -eu

STATE_DIR="/var/lib/failover"
STATE_FILE="$STATE_DIR/current_primary"

MASTER_HOST="${MYSQL_MASTER_HOST:-db}"
REPLICA_HOST="${MYSQL_REPLICA_HOST:-db_replica}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
ROOT_USER="${MYSQL_ROOT_USER:-root}"
ROOT_PASSWORD="${DB_ROOT_PASSWORD:-}"
REPLICATION_USER="${REPLICATION_USER:-}"
REPLICATION_PASSWORD="${REPLICATION_PASSWORD:-}"
CHECK_INTERVAL="${FAILOVER_CHECK_INTERVAL:-10}"
AUTO_REJOIN="${FAILOVER_AUTO_REJOIN:-true}"
FAILOVER_ENABLED="${FAILOVER_ENABLED:-true}"

if [ -z "$ROOT_PASSWORD" ]; then
  echo "DB_ROOT_PASSWORD is required for failover manager." >&2
  exit 1
fi

if [ -z "$REPLICATION_USER" ] || [ -z "$REPLICATION_PASSWORD" ]; then
  echo "REPLICATION_USER and REPLICATION_PASSWORD are required for failover manager." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
if [ ! -f "$STATE_FILE" ]; then
  echo "$MASTER_HOST" > "$STATE_FILE"
fi

MYSQL_CNF="$(mktemp)"
chmod 600 "$MYSQL_CNF"
cat > "$MYSQL_CNF" <<EOF
[client]
user=$ROOT_USER
password=$ROOT_PASSWORD
EOF
trap 'rm -f "$MYSQL_CNF"' EXIT

mysql_exec() {
  mysql --defaults-extra-file="$MYSQL_CNF" --protocol=tcp -h "$1" -P "$MYSQL_PORT" -e "$2" >/dev/null
}

mysql_exec_file() {
  mysql --defaults-extra-file="$MYSQL_CNF" --protocol=tcp -h "$1" -P "$MYSQL_PORT" < "$2" >/dev/null
}

mysql_ping() {
  mysqladmin --defaults-extra-file="$MYSQL_CNF" --protocol=tcp -h "$1" -P "$MYSQL_PORT" ping --silent >/dev/null 2>&1
}

promote_replica() {
  echo "[failover] Promoting replica $REPLICA_HOST to primary."
  mysql_exec "$REPLICA_HOST" "STOP REPLICA;"
  mysql_exec "$REPLICA_HOST" "RESET REPLICA ALL;"
  mysql_exec "$REPLICA_HOST" "SET GLOBAL super_read_only=0;"
  mysql_exec "$REPLICA_HOST" "SET GLOBAL read_only=0;"
}

rejoin_as_replica() {
  echo "[failover] Rejoining $1 as replica of $2."
  tmp_sql="$(mktemp)"
  chmod 600 "$tmp_sql"
  cat > "$tmp_sql" <<EOF
SET GLOBAL super_read_only=1;
SET GLOBAL read_only=1;
STOP REPLICA;
RESET REPLICA ALL;
CHANGE REPLICATION SOURCE TO SOURCE_HOST='$2', SOURCE_USER='$REPLICATION_USER', SOURCE_PASSWORD='$REPLICATION_PASSWORD', SOURCE_AUTO_POSITION=1;
START REPLICA;
EOF
  mysql_exec_file "$1" "$tmp_sql"
  rm -f "$tmp_sql"
}

while true; do
  if [ "$FAILOVER_ENABLED" != "true" ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  CURRENT_PRIMARY="$(cat "$STATE_FILE" 2>/dev/null || echo "$MASTER_HOST")"

  if mysql_ping "$MASTER_HOST"; then
    if [ "$CURRENT_PRIMARY" != "$MASTER_HOST" ] && [ "$AUTO_REJOIN" = "true" ]; then
      rejoin_as_replica "$MASTER_HOST" "$CURRENT_PRIMARY"
    fi
  else
    if [ "$CURRENT_PRIMARY" = "$MASTER_HOST" ]; then
      if mysql_ping "$REPLICA_HOST"; then
        promote_replica
        echo "$REPLICA_HOST" > "$STATE_FILE"
      else
        echo "[failover] Master and replica are both unreachable." >&2
      fi
    fi
  fi

  sleep "$CHECK_INTERVAL"
done

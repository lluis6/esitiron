#!/bin/sh
set -eu

apk add --no-cache curl jq >/dev/null

: "${ORCHESTRATOR_API:=http://orchestrator:3000/api}"
: "${PREFERRED_MASTER_HOST:=db}"
: "${PREFERRED_MASTER_PORT:=3306}"
: "${FAILBACK_CHECK_INTERVAL:=20}"
: "${FAILBACK_COOLDOWN_SECONDS:=120}"

log() {
  printf '[%s] %s\n' "$(date -Iseconds)" "$*"
}

while true; do
  cluster_name=$(curl -fsS "${ORCHESTRATOR_API}/clusters-info" | jq -r '.[0].ClusterName // empty' || true)
  if [ -z "${cluster_name}" ]; then
    sleep "${FAILBACK_CHECK_INTERVAL}"
    continue
  fi

  preferred="${PREFERRED_MASTER_HOST}:${PREFERRED_MASTER_PORT}"
  if [ "${cluster_name}" = "${preferred}" ]; then
    sleep "${FAILBACK_CHECK_INTERVAL}"
    continue
  fi

  instance_json=$(curl -fsS "${ORCHESTRATOR_API}/instance/${PREFERRED_MASTER_HOST}/${PREFERRED_MASTER_PORT}" || true)
  if [ -z "${instance_json}" ]; then
    sleep "${FAILBACK_CHECK_INTERVAL}"
    continue
  fi

  is_valid=$(echo "${instance_json}" | jq -r '.IsLastCheckValid // false')
  io_running=$(echo "${instance_json}" | jq -r '.ReplicationIOThreadRuning // false')
  sql_running=$(echo "${instance_json}" | jq -r '.ReplicationSQLThreadRuning // false')
  lag_valid=$(echo "${instance_json}" | jq -r '.SecondsBehindMaster.Valid // false')
  lag=$(echo "${instance_json}" | jq -r '.SecondsBehindMaster.Int64 // 9999')

  if [ "${is_valid}" != "true" ] || [ "${io_running}" != "true" ] || [ "${sql_running}" != "true" ]; then
    sleep "${FAILBACK_CHECK_INTERVAL}"
    continue
  fi

  if [ "${lag_valid}" != "true" ] || [ "${lag}" -gt 1 ]; then
    sleep "${FAILBACK_CHECK_INTERVAL}"
    continue
  fi

  log "Ejecutando failback al master preferido ${preferred} (cluster actual: ${cluster_name})."
  curl -fsS "${ORCHESTRATOR_API}/graceful-master-takeover/${cluster_name}/${PREFERRED_MASTER_HOST}/${PREFERRED_MASTER_PORT}" | jq -r '.Message' || true
  sleep "${FAILBACK_COOLDOWN_SECONDS}"
done

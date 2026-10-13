#!/usr/bin/env bash
# Throwaway NATS servers for testing every authentication mode of the NATS driver.
#
#   eval "$(scripts/nats-auth-fixture.sh start)"   # starts the servers, exports DBCLIENT_NATS_AUTH_*
#   scripts/nats-auth-fixture.sh stop              # removes the containers and the generated keys
#
# Ports: 14222 user/password + nkey, 14223 token, 14224 operator mode (credentials file).
# Keys, password and token are random and generated for this run only (nsc/nk from natsio/nats-box).
set -euo pipefail

IMAGE=nats:2.12.0
BOX=natsio/nats-box:latest
STATE="${TMPDIR:-/tmp}/dbclient-nats-auth"
NAMES=(dbclient-nats-auth-users dbclient-nats-auth-token dbclient-nats-auth-creds)

stop() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

start() {
  stop
  mkdir -p "$STATE"
  local user="tester" password token
  password=$(openssl rand -hex 16)
  token=$(openssl rand -hex 24)

  # nkey user plus an operator → account → user chain for the .creds file.
  docker run --rm -u "$(id -u):$(id -g)" -v "$STATE:/w" -e HOME=/w "$BOX" sh -ec '
    nk -gen user -pubout > /w/nkey.txt
    F="--config-dir /w/cfg --data-dir /w/store --keystore-dir /w/keys"
    nsc $F add operator --name OP --sys
    nsc $F add account --name APP
    nsc $F add user --account APP --name alice
    nsc $F generate creds --account APP --name alice > /w/alice.creds
    nsc $F generate config --mem-resolver --config-file /w/creds.conf
  ' >/dev/null 2>&1
  local seed pub
  seed=$(sed -n 1p "$STATE/nkey.txt")
  pub=$(sed -n 2p "$STATE/nkey.txt")

  cat > "$STATE/users.conf" <<EOF
authorization { users: [ { user: "$user", password: "$password" }, { nkey: "$pub" } ] }
EOF
  cat > "$STATE/token.conf" <<EOF
authorization { token: "$token" }
EOF

  docker run -d --rm --name dbclient-nats-auth-users -p 14222:4222 -v "$STATE:/w:ro" "$IMAGE" -c /w/users.conf >/dev/null
  docker run -d --rm --name dbclient-nats-auth-token -p 14223:4222 -v "$STATE:/w:ro" "$IMAGE" -c /w/token.conf >/dev/null
  docker run -d --rm --name dbclient-nats-auth-creds -p 14224:4222 -v "$STATE:/w:ro" "$IMAGE" -c /w/creds.conf >/dev/null
  sleep 1

  echo "export DBCLIENT_NATS_AUTH_USERS_SERVERS=localhost:14222"
  echo "export DBCLIENT_NATS_AUTH_USER=$user"
  echo "export DBCLIENT_NATS_AUTH_PASSWORD=$password"
  echo "export DBCLIENT_NATS_AUTH_SEED=$seed"
  echo "export DBCLIENT_NATS_AUTH_TOKEN_SERVERS=localhost:14223"
  echo "export DBCLIENT_NATS_AUTH_TOKEN=$token"
  echo "export DBCLIENT_NATS_AUTH_CREDS_SERVERS=localhost:14224"
  echo "export DBCLIENT_NATS_AUTH_CREDS_FILE=$STATE/alice.creds"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

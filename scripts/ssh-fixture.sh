#!/usr/bin/env bash
# Throwaway SSH server for testing SSH tunnels.
#
#   eval "$(scripts/ssh-fixture.sh start)"   # starts sshd on localhost:12222, exports DBCLIENT_SSH_*
#   scripts/ssh-fixture.sh stop              # removes the container and the keys
#
# User "tunnel" logs in with a random password, an ed25519 key, or an ed25519 key protected by a
# passphrase. TCP forwarding is allowed; from inside the container the host's databases are at
# host.docker.internal (DBCLIENT_SSH_TARGET_HOST).
set -euo pipefail

STATE="${TMPDIR:-/tmp}/dbclient-ssh"
NAME=dbclient-ssh

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

start() {
  stop
  mkdir -p "$STATE"
  local password passphrase
  password=$(openssl rand -hex 12)
  passphrase=$(openssl rand -hex 12)
  ssh-keygen -q -t ed25519 -N '' -C dbclient-test -f "$STATE/id_plain"
  ssh-keygen -q -t ed25519 -N "$passphrase" -C dbclient-test -f "$STATE/id_protected"
  cat "$STATE/id_plain.pub" "$STATE/id_protected.pub" > "$STATE/authorized_keys"
  chmod 644 "$STATE/authorized_keys"

  docker run -d --rm --name "$NAME" -p 12222:22 --memory 64m -v "$STATE:/keys:ro" -e PASSWORD="$password" alpine:3.20 sh -ec '
    apk add --no-cache openssh-server >/dev/null
    ssh-keygen -A >/dev/null
    adduser -D -s /bin/sh tunnel
    echo "tunnel:$PASSWORD" | chpasswd 2>/dev/null
    mkdir -p /home/tunnel/.ssh && cp /keys/authorized_keys /home/tunnel/.ssh/ && chown -R tunnel /home/tunnel/.ssh && chmod 700 /home/tunnel/.ssh && chmod 600 /home/tunnel/.ssh/authorized_keys
    exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o AllowTcpForwarding=yes -o PermitRootLogin=no' >/dev/null

  for _ in $(seq 1 60); do
    docker logs "$NAME" 2>&1 | grep -q "Server listening" && break
    sleep 1
  done
  local hostkey
  hostkey=$(docker exec "$NAME" ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')

  echo "export DBCLIENT_SSH_HOST=localhost"
  echo "export DBCLIENT_SSH_PORT=12222"
  echo "export DBCLIENT_SSH_USER=tunnel"
  echo "export DBCLIENT_SSH_PASSWORD=$password"
  echo "export DBCLIENT_SSH_KEY=$STATE/id_plain"
  echo "export DBCLIENT_SSH_PROTECTED_KEY=$STATE/id_protected"
  echo "export DBCLIENT_SSH_PASSPHRASE=$passphrase"
  echo "export DBCLIENT_SSH_HOSTKEY=$hostkey"
  echo "export DBCLIENT_SSH_TARGET_HOST=host.docker.internal"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

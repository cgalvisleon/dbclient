#!/usr/bin/env bash
# Throwaway TLS servers for testing the SSL/TLS settings of the drivers.
#
#   eval "$(scripts/tls-fixture.sh start)"   # starts the servers, exports DBCLIENT_TLS_*
#   scripts/tls-fixture.sh stop              # removes the containers and the certificates
#
# A fresh CA signs a server certificate (localhost, 127.0.0.1) and a client certificate.
# Ports: 15432 PostgreSQL (SSL only; user "certuser" also needs the client certificate),
# 13306 MySQL (secure transport required; "certuser" REQUIRE X509), 16380 Redis (TLS only,
# client certificate required), 14226 NATS (TLS, client certificate verified) and 12484, a TLS
# proxy in front of the Oracle listener on localhost:1521 (Oracle itself is not changed).
set -euo pipefail

STATE="${TMPDIR:-/tmp}/dbclient-tls"
NAMES=(dbclient-tls-pg dbclient-tls-mysql dbclient-tls-redis dbclient-tls-nats dbclient-tls-oracle)

stop() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

start() {
  stop
  mkdir -p "$STATE"
  cd "$STATE"
  local password
  password=$(openssl rand -hex 12)
  {
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=dbclient test CA" -keyout ca.key -out ca.crt
    openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile server.ext -out server.crt
    openssl req -newkey rsa:2048 -nodes -subj "/CN=certuser" -keyout client.key -out client.csr
    printf 'extendedKeyUsage=clientAuth\n' > client.ext
    openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile client.ext -out client.crt
    # The same client key, encrypted, to test passphrases.
    openssl pkey -in client.key -aes256 -passout "pass:$password" -out client-encrypted.key
    cat server.crt server.key > server.pem
  } >/dev/null 2>&1
  chmod 644 ./*

  # PostgreSQL: SSL only; certuser authenticates with password and client certificate.
  cat > pg-init.sh <<EOF
psql -v ON_ERROR_STOP=1 -U postgres -c "create user certuser password '$password'"
cat > "\$PGDATA/pg_hba.conf" <<'HBA'
local all all trust
hostssl all certuser 0.0.0.0/0 scram-sha-256 clientcert=verify-ca
hostssl all all 0.0.0.0/0 scram-sha-256
hostnossl all all 0.0.0.0/0 reject
HBA
EOF
  docker run -d --rm --name dbclient-tls-pg -p 15432:5432 --memory 200m -e POSTGRES_PASSWORD="$password" -v "$STATE:/certs:ro" \
    --entrypoint sh postgres:15 -c '
      cp /certs/server.crt /certs/server.key /certs/ca.crt /tmp/ && chown postgres /tmp/server.* /tmp/ca.crt && chmod 600 /tmp/server.key
      cp /certs/pg-init.sh /docker-entrypoint-initdb.d/
      exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key -c ssl_ca_file=/tmp/ca.crt' >/dev/null

  # MySQL: encrypted connections required; certuser must present a client certificate.
  cat > mysql-init.sql <<EOF
CREATE USER 'certuser'@'%' IDENTIFIED BY '$password' REQUIRE X509;
EOF
  # Small memory footprint (and a hard cap) so it never pushes other containers out of Docker's memory.
  docker run -d --rm --name dbclient-tls-mysql -p 13306:3306 --memory 400m -e MYSQL_ROOT_PASSWORD="$password" -v "$STATE:/certs:ro" \
    -v "$STATE/mysql-init.sql:/docker-entrypoint-initdb.d/init.sql:ro" mysql:8.4 \
    --ssl-ca=/certs/ca.crt --ssl-cert=/certs/server.crt --ssl-key=/certs/server.key --require-secure-transport=ON \
    --performance-schema=OFF --innodb-buffer-pool-size=16M --mysqlx=OFF >/dev/null

  # Redis: TLS only, client certificate required.
  docker run -d --rm --name dbclient-tls-redis -p 16380:6379 -v "$STATE:/certs:ro" redis:7.2.4 \
    redis-server --port 0 --tls-port 6379 --tls-cert-file /certs/server.crt --tls-key-file /certs/server.key \
    --tls-ca-cert-file /certs/ca.crt --tls-auth-clients yes --requirepass "$password" >/dev/null

  # NATS: TLS with client certificate verification.
  cat > nats.conf <<'EOF'
tls { cert_file: "/certs/server.crt", key_file: "/certs/server.key", ca_file: "/certs/ca.crt", verify: true }
EOF
  docker run -d --rm --name dbclient-tls-nats -p 14226:4222 -v "$STATE:/certs:ro" nats:2.12.0 -c /certs/nats.conf >/dev/null

  # Oracle: a TLS proxy to the existing listener, so the thin driver speaks TCPS.
  docker run -d --rm --name dbclient-tls-oracle -p 12484:2484 -v "$STATE:/certs:ro" alpine/socat:1.8.0.0 \
    "OPENSSL-LISTEN:2484,fork,reuseaddr,cert=/certs/server.pem,cafile=/certs/ca.crt,verify=0" TCP:host.docker.internal:1521 >/dev/null

  # Wait for PostgreSQL and MySQL to finish their first start.
  for _ in $(seq 1 60); do
    docker logs dbclient-tls-pg 2>&1 | grep -q "database system is ready to accept connections" &&
      [ "$(docker logs dbclient-tls-pg 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] &&
      docker logs dbclient-tls-mysql 2>&1 | grep -q "port: 3306  MySQL Community Server" && break
    sleep 2
  done

  echo "export DBCLIENT_TLS_DIR=$STATE"
  echo "export DBCLIENT_TLS_PASSWORD=$password"
  echo "export DBCLIENT_TLS_PG=localhost:15432"
  echo "export DBCLIENT_TLS_MYSQL=localhost:13306"
  echo "export DBCLIENT_TLS_REDIS=localhost:16380"
  echo "export DBCLIENT_TLS_NATS=localhost:14226"
  echo "export DBCLIENT_TLS_ORACLE=localhost:12484"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

#!/bin/bash
set -eux
# Vespa self-host bootstrap on AL2023 ARM64.
# Instance type MUST be t4g.large (8 GiB): Vespa Docker image requires >=4 GiB available RAM.
# t4g.medium (4 GiB) fails the memory gate even when the instance is "running".

dnf -y update
dnf -y install docker
systemctl enable --now docker

mkdir -p /opt/vespa-var
chown 1000:1000 /opt/vespa-var

docker pull vespaengine/vespa:latest
docker run -d --name vespa \
  --restart=unless-stopped \
  --hostname vespa-container \
  --ulimit nofile=262144:262144 \
  --ulimit nproc=409600:409600 \
  -p 8080:8080 -p 19071:19071 -p 19092:19092 \
  -v /opt/vespa-var:/opt/vespa/var \
  vespaengine/vespa:latest

for i in $(seq 1 60); do
  if curl -sf http://localhost:19071/state/v1/health 2>/dev/null | grep -q '"status"'; then
    echo "Vespa config server up at attempt $i" > /var/log/vespa-bootstrap.log
    break
  fi
  sleep 3
done

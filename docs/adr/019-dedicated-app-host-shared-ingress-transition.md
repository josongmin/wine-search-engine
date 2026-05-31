# ADR-019: Dedicated app host with shared ingress transition

- Status: Accepted
- Date: 2026-06-01
- Supersedes: —
- Related: ADR-001 (Trust boundaries), GitHub Actions + AWS EC2 deploy runbook, RFC-006 (Search snapshot publish architecture)

## Context

Production `wine-search-engine` was running on a shared EC2 host together with crawler services, `wine-shopping-app`, nginx, and other long-lived processes. The live host state on 2026-06-01 was:

- shared app host: `i-0e3df08f16fe1c1b5`, `t3.large`, `x86_64`
- search container: `wine-search-engine`
- runtime image: `527687867704.dkr.ecr.ap-northeast-2.amazonaws.com/wine-search-engine:manual-ec2-amd64-v4`
- container bind: `127.0.0.1:4000 -> 3000`
- public ingress: nginx on the same shared host, `https://asommguide.shop:9011 -> 127.0.0.1:4000`
- Vespa host: separate EC2 `i-06cbec79408547420`

This created two concrete problems:

1. app deploy blast radius was coupled to crawler and miscellaneous host load.
2. moving directly to a brand-new public host would also require DNS and certificate custody changes, but the current public DNS zone is not managed in this AWS account.

## Decision

Introduce a dedicated EC2 app host for `wine-search-engine`, but keep the existing shared host as the public TLS ingress during the first transition step.

### Target topology

- dedicated app host
  - runs only the `wine-search-engine` container
  - pulls images from ECR
  - is managed only through SSM
  - exposes host port `4000/tcp` to the VPC, not to the public internet
- shared ingress host
  - keeps nginx and the existing certificates
  - proxies `https://asommguide.shop:9011` to the dedicated host private IP on `4000`
- Vespa host
  - remains unchanged
  - receives SG-based allow rules from the new dedicated app host SG on `8080`, `19071`, and `19092`

### Operational rules

1. Keep the existing container rollout model: `ECR -> SSM -> docker run`.
2. Change the rollout script to support an explicit host bind IP so the dedicated host can publish `4000` on `0.0.0.0` while the legacy shared host keeps the default loopback bind.
3. Reuse the existing runtime substrate model:
   - env file: `/etc/wine-search-engine.env`
   - data dir: `/opt/wine-search-engine/data`
   - required data files:
     - `runtime-search-snapshot.json`
     - `nl-mappings.json`
4. Copy runtime state between hosts with `SSM -> S3 -> SSM`, not by SSH or manual file copy.
5. Keep rollback simple:
   - dedicated host deploy rollback: redeploy prior ECR tag
   - ingress rollback: point nginx upstream back to `127.0.0.1:4000` on the shared host

## Consequences

**Positive**

- app CPU/memory contention is separated from crawler and auxiliary workloads
- deployment and rollback can stay inside the existing `docker + ECR + SSM` operating model
- no immediate DNS migration or new certificate issuance is required
- ingress rollback is one nginx upstream change, not a DNS revert

**Negative**

- the shared host remains a production dependency because nginx and TLS still terminate there
- the dedicated host is not yet the full public edge, so this is only a partial isolation step
- runtime state still depends on explicit synchronization of `/etc/wine-search-engine.env` and `/opt/wine-search-engine/data`

**Out of scope**

- moving DNS for `asommguide.shop` into this AWS account
- moving TLS certificates off the shared host
- replacing EC2+docker with ECS/EKS or host-native systemd runtime

## References

- Provisioning script: `scripts/deploy/provision-dedicated-app-host.sh`
- Runtime state sync: `scripts/deploy/clone-runtime-state-between-hosts.sh`
- Container rollout: `scripts/deploy/ssm-rollout-from-ecr.sh`
- Ingress switch: `scripts/deploy/switch-shared-ingress-upstream.sh`
- Shared ingress nginx generator: `scripts/deploy/provision-nginx-public-port.sh`
- Detailed operator guide: `docs/runbook-dedicated-app-host-deploy.md`

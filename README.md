# k8s-langfuse-pocharlies

Self-hosted **Langfuse v3** (LLM observability: traces, sessions, prompt debugging,
evaluation) for the cluster, integrated with LiteLLM. It is an **additive** layer —
Prometheus / Grafana / VictoriaMetrics remain the operational/SLO metrics stack;
Langfuse is only for LLM traces, never a metrics replacement.

Deployed via the ArgoCD Application `langfuse`
(`k8s-gitops-pocharlies/apps/langfuse.yaml`), a multi-source app that renders the
upstream Helm chart `langfuse/langfuse` (pinned `1.5.38`, appVersion `3.205.1`) with
the `values.yaml` and platform manifests in this repo.

```
k8s/
  values.yaml                     # Helm values ($values/k8s/values.yaml)
  platform/                       # applied as raw manifests (path: k8s/platform)
    externalsecret.yaml           # langfuse-secrets  <- Vault secret/langfuse
    ingressroute.yaml             # langfuse.e-dani.com behind Keycloak SSO
    networkpolicy.yaml            # default-deny ingress + allow cluster/tailscale
```

## Arquitectura / backing stores

| Componente  | Decisión                     | Destino |
|-------------|------------------------------|---------|
| PostgreSQL  | **REUSE** shared CNPG        | `postgres-shared-rw.databases.svc:5432` DB `langfuse`, role `langfuse` |
| S3 / blob   | **REUSE** shared MinIO       | `minio-s3.minio.svc:9000` bucket `langfuse` (prefixes `events/ media/ exports/`) |
| Redis/Valkey| **DEDICATED** (chart)        | `langfuse-redis-primary:6379` (BullMQ queue, `noeviction`) |
| ClickHouse  | **DEDICATED** (chart, 1 node)| `langfuse-clickhouse:8123/9000` (required by v3; none existed in-cluster) |

Why dedicated Valkey instead of shared-valkey: the shared instance is Sentinel-managed
with an **out-of-band ACL secret** (`shared-valkey-acl`, not in Git) that can't be
extended with a `langfuse` user from GitOps, and it is shared with brain/socialmedia.
A dedicated standalone Valkey isolates the queue and keeps the whole deploy GitOps-clean.
(To switch to shared-valkey later: set `redis.deploy:false` + `redis.sentinel.*` in
`values.yaml` and add a langfuse ACL user to `shared-valkey-acl` — see Rollback.)

## Secretos (Vault, sin texto plano en Git)

All secrets live in Vault under the KV-v2 mount `secret`. Two paths, materialised by
ExternalSecrets via the `vault-backend` ClusterSecretStore. **Seed them before syncing.**
(KV v2 mount `secret`; the ExternalSecret `key: secret/langfuse` reads exactly what
`vault kv put secret/langfuse` writes — same convention as the existing `secret/litellm`.)

Generate the crypto material:
```bash
NEXTAUTH_SECRET=$(openssl rand -base64 32)
SALT=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)        # 64 hex chars, required
PROJECT_PUBLIC_KEY="pk-lf-$(openssl rand -hex 16)"
PROJECT_SECRET_KEY="sk-lf-$(openssl rand -hex 16)"
```

`secret/langfuse` (app + CNPG role + MinIO creds + head-less bootstrap):
```bash
vault kv put secret/langfuse \
  SALT="$SALT" ENCRYPTION_KEY="$ENCRYPTION_KEY" NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  DB_USER=langfuse DB_PASSWORD="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32)" \
  REDIS_PASSWORD="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32)" \
  CLICKHOUSE_PASSWORD="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32)" \
  S3_ACCESS_KEY_ID="<minio access key for bucket langfuse>" \
  S3_SECRET_ACCESS_KEY="<minio secret key>" \
  INIT_PROJECT_PUBLIC_KEY="$PROJECT_PUBLIC_KEY" \
  INIT_PROJECT_SECRET_KEY="$PROJECT_SECRET_KEY" \
  INIT_USER_EMAIL="me@e-dani.com" \
  INIT_USER_PASSWORD="<admin login password>"
```

`secret/litellm` (add the SAME project keys so LiteLLM logs into this project):
```bash
vault kv patch secret/litellm \
  LANGFUSE_PUBLIC_KEY="$PROJECT_PUBLIC_KEY" \
  LANGFUSE_SECRET_KEY="$PROJECT_SECRET_KEY"
```

MinIO credentials: **you MUST create a bucket-scoped access key** limited to
`arn:aws:s3:::langfuse/*` and put it in `S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY`. Do NOT
reuse the MinIO root key or any broad key — a compromised Langfuse pod would otherwise
reach every bucket in the shared MinIO (velero-backups, cnpg-backups, harbor-blobs,
loki-chunks, longhorn-backups). The bucket itself is created by
`k8s-infra-pocharlies/storage/minio/bootstrap-buckets.yaml`.

## Orden de despliegue (GitOps)

1. **Create the GitHub repo** `pocharlies-org/k8s-langfuse-pocharlies`, push this tree,
   create branch **`deploy/prod`** (that's the `targetRevision`).
2. **Seed Vault** (`secret/langfuse` + `secret/litellm` keys above).
3. **Merge/sync `k8s-infra-pocharlies`** first (adds the `langfuse` CNPG role + `langfuse`
   Database + `langfuse-db-credentials` ESO + the MinIO `langfuse` bucket). Wait for the
   `k8s-infra` app to be Synced/Healthy so the DB + bucket exist.
4. **Merge/sync `k8s-gitops-pocharlies`** (registers the repo + Helm chart in
   `argocd/repositories.yaml`, adds `apps/langfuse.yaml`, kustomization line).
5. ArgoCD creates the `langfuse` Application → syncs the chart + platform manifests.
   ESO (sync-wave -5) creates `langfuse-secrets`, then web/worker start, run Prisma +
   ClickHouse migrations, and head-lessly create org `edani` / project `litellm-gateway`
   / the admin user.
6. **Sync `k8s-litellm-pocharlies`** (already patched: `langfuse` callback + `LANGFUSE_*`
   env + `turn_off_message_logging`). LiteLLM restarts and starts emitting traces.

## Acceso

- **UI:** https://langfuse.e-dani.com — gated by Keycloak SSO (oauth2-proxy), then the
  Langfuse login (email `INIT_USER_EMAIL` + `INIT_USER_PASSWORD`). Public signup is
  disabled.
- **Internal ingest (LiteLLM → Langfuse):** `http://langfuse-web.langfuse.svc.cluster.local:3000`
  (no SSO on the internal service; NetworkPolicy limits it to the cluster overlay).

## Validación / prueba E2E

```bash
# 0) infra ready
kubectl -n databases get database.postgresql.cnpg.io langfuse
kubectl -n databases get externalsecret langfuse-db-credentials     # SecretSynced=True
# 1) secret + pods
kubectl -n langfuse get externalsecret langfuse-secrets             # SecretSynced=True
kubectl -n langfuse get pods                                        # web, worker, clickhouse-shard0-0, redis-primary-0 Running
kubectl -n langfuse logs deploy/langfuse-web | grep -iE 'migrat|listening|ready'
# 2) health
kubectl -n langfuse exec deploy/langfuse-web -- wget -qO- localhost:3000/api/public/ready
# 3) fire a LiteLLM call with useful metadata/tags
curl -sS https://litellm.lan.e-dani.com/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen36-35b",
       "messages":[{"role":"user","content":"langfuse smoke test"}],
       "metadata":{"tags":["tenant:test","service:manual-smoke","workflow:validation","model_alias:qwen36-35b"],
                   "session_id":"smoke-1","trace_id":"smoke-1","generation_name":"langfuse-smoke"}}'
# 4) open https://langfuse.e-dani.com -> project "litellm-gateway" -> Tracing -> Traces
#    filter tag service:manual-smoke -> the trace appears (latency/cost/model/tags present;
#    message CONTENT is redacted while turn_off_message_logging=true).
```

### Metadata contract for callers (e.g. Synapse)

Pass a `metadata` object on each `/chat/completions` call. LiteLLM's Langfuse callback honors:

| key | use |
|---|---|
| `tags` (list) | filter dimension — `tenant:…`, `service:…`, `workflow:…`, `model_alias:…` |
| `trace_id` / `existing_trace_id` | correlation id (new trace / attach to existing) |
| `session_id` | groups a conversation |
| `trace_user_id` | end-user / tenant identity |
| `generation_name` | human name of the step/handler |

> **Privacy caveat:** `turn_off_message_logging: true` only redacts the message *body*.
> Fields in `metadata` (`tags`, `session_id`, `trace_user_id`, `generation_name`) are
> shipped to Langfuse verbatim. Callers MUST NOT put raw prompt text or customer PII in
> them — use opaque ids (e.g. `tenant:acme`, `session:<uuid>`), not names/emails/content.

## Rollback

**Disable LiteLLM → Langfuse only** (keeps Langfuse running, LiteLLM keeps db+prometheus):
in `k8s-litellm-pocharlies/k8s/manifest.yaml` remove `- langfuse` from
`success_callback`/`failure_callback`, delete the `turn_off_message_logging` line and the
three `LANGFUSE_*` env vars; sync litellm.

**Re-enable prompt/response content in traces:** set `turn_off_message_logging: false`
(or delete the line) in the litellm config; sync. (This also un-redacts the DB spend-logs.)

**Remove Langfuse entirely:**
1. Delete `- apps/langfuse.yaml` from `k8s-gitops-pocharlies/kustomization.yaml` (and the
   `apps/langfuse.yaml` file); revert `gen_repositories.py` + re-run it.
2. `kubectl delete application langfuse -n argocd` (syncPolicy prune=false won't auto-delete).
3. PVCs for ClickHouse/Valkey are `Retain`-class — delete them manually if you want the
   storage back: `kubectl -n langfuse delete pvc -l app.kubernetes.io/instance=langfuse`.
4. Optional: drop the `langfuse` CNPG `Database`/role and `langfuse-db-credentials` ESO
   from `k8s-infra-pocharlies`, and the `langfuse` MinIO bucket line.
5. Optional: `vault kv delete secret/langfuse` and remove the two LANGFUSE_* keys
   from `secret/litellm`.

## Gotchas

- **Bitnami legacy images:** the chart pulls ClickHouse/Valkey from `bitnamilegacy/*`
  (`global.security.allowInsecureImages: true`). Free but unmaintained upstream — mirror
  to Harbor and override `clickhouse.image` / `redis.image` when hardening.
- **No `/metrics`:** Langfuse OSS does not expose Prometheus metrics, so there is
  deliberately no `VMServiceScrape`. Operational health = pod/kube metrics + the
  `/api/public/ready` probe. LLM traces live in Langfuse, SLO metrics stay in Prometheus.
- **ArgoCD multi-source:** `$values` resolves to the ref repo root, so the valueFile is
  `$values/k8s/values.yaml` while only `k8s/platform/*` is applied. If your ArgoCD version
  dislikes a source having both `ref` and `path`, split into two Applications (chart-only
  + a git app on `path: k8s/platform`).
- **Postgres/ClickHouse must run UTC** (CNPG cluster already is).

# ARCHITECTURE.md — k8s-langfuse-pocharlies

> Langfuse v3 autoalojado (trazas, sesiones y evaluación de LLM) integrado con LiteLLM. Capa **aditiva**: las métricas
> operativas siguen en VictoriaMetrics. Escrito por `architect` (SC-1426).

## 1. Clientes y versiones

| cliente | repositorio / ruta | versión desplegada | cómo se despliega |
|---|---|---|---|
| UI/API Langfuse (`langfuse-web`, workers) | `k8s/values.yaml` sobre el chart upstream | chart `langfuse` **1.5.38** (appVersion 3.205.1), `langfuse.github.io/langfuse-k8s` | ArgoCD app `langfuse` (multi-source) |
| Manifiestos de plataforma | `k8s/platform/` (ExternalSecret, NetworkPolicy, IngressRoute LAN, CronJob de retención) | `origin/main` = 4cb9a8a | misma app, 2.º source path `k8s/platform` |

UI pública `langfuse.e-dani.com` vía IngressRoute central en `k8s-infra-pocharlies/networking/traefik-edge/langfuse-public.yaml`;
LAN por `ingressroute-lan.yaml` (sin SSO).

## 2. Dependencias, en ambos sentidos

- **Depende de** — Postgres compartido (`postgres-shared-rw.databases`, bd/rol `langfuse`), MinIO compartido
  (`minio-s3.minio:9000`, bucket `langfuse` con clave **limitada al bucket**; el bucket lo crea
  `k8s-infra-pocharlies/storage/minio/bootstrap-buckets.yaml`), ClickHouse y Valkey **dedicados** del chart, 1Password
  (`ClusterSecretStore onepassword`, item `langfuse`), `sso-chain` de Traefik.
- **Dependen de él** — `k8s-litellm-pocharlies` (callback de trazas; mismas `LANGFUSE_PUBLIC/SECRET_KEY` en el item
  `litellm`); consumidores del test `tests/retention-diagnostics.test.mjs`: nadie más.
- **ArgoCD** `langfuse`: repo `pocharlies-org/k8s-langfuse-pocharlies`, path `k8s/platform` + chart externo, tronco **`main`**.

## 3. Stack

| pieza | versión | para qué | no se usa en su lugar |
|---|---|---|---|
| Langfuse | 3.205.1 | observabilidad LLM | LangSmith/Helicone |
| ClickHouse (1 nodo, chart) | chart | requerido por v3 | — |
| Valkey dedicado (`noeviction`) | chart | cola BullMQ | `shared-valkey` (Sentinel + ACL fuera de Git) |
| Node 20 (imagen langfuse) | — | CronJob `langfuse-retention` 04:00 UTC | imagen propia |

## 4. Componentes compartidos

| concepto | pieza canónica | ruta | quién la usa |
|---|---|---|---|
| Postgres / MinIO | `postgres-shared`, `minio-s3` | `k8s-infra-pocharlies` | langfuse |
| Retención de trazas | `langfuse-retention` | `k8s/platform/retention-cronjob.yaml` | este repo |
| Secretos | ExternalSecret `langfuse-secrets` | `k8s/platform/externalsecret.yaml` | chart |

## 5. Cómo se construye aquí

Config del chart en `k8s/values.yaml`; lo que el chart no cubre va como manifiesto crudo en `k8s/platform/`. Secretos
**solo** en 1Password (item `langfuse`, campos `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, claves de proyecto…),
sembrados **antes** de sincronizar. NetworkPolicy deny-by-default + allow cluster/tailscale.

## 6. Tests y validaciones

```sh
node --test tests/retention-diagnostics.test.mjs
```
1 fichero de test (el script de retención); sin tests de los manifiestos (los valida el CI si lo hubiera, ver §7).

## 7. CI/CD y despliegue

- Solo `pr-review.yml` (**sin `ci.yml`**: ni kustomize/helm lint ni el test Node se ejecutan en CI → hueco para el tech-lead).
- Despliegue: merge a `main` → ArgoCD. **Validación en producción**: login en `https://langfuse.e-dani.com` y ver una traza
  reciente de LiteLLM; CronJob `langfuse-retention` con último Job `Complete`. Synced ≠ funcionando. Pendiente de ejecutar.
- Subir versión: cambiar `targetRevision` del chart **en `k8s-gitops-pocharlies/apps/langfuse.yaml`** y la imagen de retención.

## 8. Decisiones y trampas

- Valkey dedicado en vez de `shared-valkey`: el ACL de ese está fuera de Git (`shared-valkey-acl`); cambiarlo exige añadir usuario
  allí (ver «Rollback» del README).
- Hasta SC-490 los secretos vivían en Vault KV-v2; ahora en 1Password (mismo convenio `item/field` que `litellm`).
- Nunca reutilizar la clave root de MinIO: un pod de Langfuse comprometido alcanzaría velero/cnpg/harbor/loki/longhorn.

Última verificación contra el código: 2026-10-01 · 4cb9a8a (origin/main)

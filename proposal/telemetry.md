# Sandbox Lifecycle Telemetry

## 1. Goal

Emit a structured telemetry event every time a sandbox is created or deleted, so we can answer:

- How many sandboxes does each user create per day, and how many succeed?
- What is the live duration (lifetime) distribution per user / template?
- Why are sandboxes being removed (user request, timeout, idle, capacity, error)?

Telemetry must never block or fail the create / delete flow. If the exporter is misconfigured or down, the user request still completes normally.

## 2. Events

Two event types only. Both use the same envelope plus event-specific fields.

| Event | When emitted | Source |
| --- | --- | --- |
| `sandbox.create` | After `Controller.Create` returns (success or failure), once per request. | Native handler and E2B handler. |
| `sandbox.delete` | After the underlying ReplicaSet delete call returns. Emitted from the scaler that triggered the delete, or from the user-initiated delete handler. | `Controller.Delete*`, `timeout_scaler`, `idle_scaler`, user API. |

Pause is not a delete event. Pause / resume already have their own annotations and are out of scope for this proposal. A subsequent hard-delete of a paused sandbox still emits `sandbox.delete`.

### 2.1 Envelope (common fields)

| Field | Type | Notes |
| --- | --- | --- |
| `event` | string | `sandbox.create` or `sandbox.delete`. |
| `event_id` | string (uuid) | One UUID per emitted event. Used for de-dup downstream. |
| `event_time` | RFC3339 string | Time the event was emitted, UTC. |
| `schema_version` | int | Starts at `1`. Bumped on breaking field changes. |
| `service` | string | Constant `agent-sandbox`. Set as OTel resource attribute. |
| `service_instance` | string | Pod name / hostname. Set as OTel resource attribute. |

### 2.2 `sandbox.create`

| Field | Type | Notes |
| --- | --- | --- |
| `user_key` | string | The sandbox owner key — leading 2/3 of `Sandbox.User` (same value as the `sbx-user` label, with the trailing identifying suffix trimmed). |
| `sandbox_id` | string | `Sandbox.ID`. Empty on early failure (e.g. capacity reject before ID assignment). |
| `sandbox_name` | string | `Sandbox.Name`. Empty on early failure. |
| `template` | string | `Sandbox.Template`. |
| `app` | string | `Sandbox.App`. |
| `from_pool` | bool | Whether the ReplicaSet was acquired from the warm pool. False on pool-acquire failure. |
| `auto_pause` | bool | `Sandbox.AutoPause` — whether timeout / idle-timeout cleanup should pause instead of delete. |
| `success` | bool | True if `Controller.Create` returned without error and the sandbox reached `Running`. |
| `error_message` | string | Raw error string from `Controller.Create`, truncated to 256 bytes. Empty on success. |
| `duration_ms` | int | Wall-clock from `Controller.Create` entry to its return. |

The create event is emitted from a single point — `Controller.Create` — so all create-time outcomes (pool acquire, readiness wait) end up in one place. Upstream caller-side failures (rate limit, request decode, name conflict, validation) are intentionally **not** instrumented as create events: they never reach the controller and are not part of the sandbox lifecycle. They show up in HTTP access logs instead.

### 2.3 `sandbox.delete`

| Field | Type | Notes |
| --- | --- | --- |
| `user_key` | string | Same hashing rule as create. |
| `sandbox_id` | string | `Sandbox.ID`. |
| `sandbox_name` | string | `Sandbox.Name`. |
| `template` | string | `Sandbox.Template`. |
| `app` | string | `Sandbox.App`. |
| `from_pool` | bool | Whether the sandbox was a pool sandbox (informational; pool sandboxes generally do not count toward user quota). |
| `auto_pause` | bool | `Sandbox.AutoPause` at the moment of delete. Useful for separating "deletes that bypassed pause" from regular pause-eligible workloads. |
| `created_at` | RFC3339 string | `Sandbox.CreatedAt` (from `sandbox-data` annotation). |
| `deleted_at` | RFC3339 string | Time the delete event is emitted. |
| `alive_seconds` | int | `deleted_at - created_at`. Includes any paused time. |
| `reason` | string | Enum, see 2.4. |
| `success` | bool | True if the underlying `ReplicaSets.Delete` call succeeded. |
| `error_class` | string | Empty on success. One of: `not_found`, `forbidden`, `internal_error`. |
| `error_message` | string | Truncated to 256 bytes. Empty on success. |

### 2.4 `reason` enum (delete)

| Reason | Trigger |
| --- | --- |
| `user_request` | Explicit `DELETE` from native or E2B API. |
| `timeout` | `timeout_scaler` removed the sandbox after its absolute timeout. |
| `idle_timeout` | `idle_scaler` removed the sandbox after the idle window. |
| `pause_failed_fallback` | Pause attempt failed and the scaler fell back to delete (corresponds to existing `SandboxPauseFailed`). |
| `template_cleanup` | `DeleteByTemplateName` removed pool sandboxes for a template. |
| `admin` | Internal / operator-initiated delete that does not come from a user API. |
| `unknown` | Default fallback when no caller passed a reason. Should not appear in normal operation; surfaces missing instrumentation. |

The reason is passed into the controller delete path, not inferred from call sites afterward. See section 4.

## 3. Transport

Events are emitted as OpenTelemetry **log records** through the `pkg/telemetry` package, which uses `otlploghttp`. Logs are the right OTel signal here because each event is a discrete, structured occurrence with high-cardinality fields (`sandbox_id`, `user_key`) that we do not want as metric label dimensions.

The default backend is **VictoriaLogs**, deployed in-cluster as a single-instance StatefulSet (see `install/victorialogs.yaml`). VictoriaLogs is a lightweight log database in the VictoriaMetrics family. It speaks OTLP/HTTP natively, has no external dependencies (no Elasticsearch, no Kafka), persists data on a PVC, and ships a LogsQL query API. For agent-sandbox lifecycle volume (one event per create / delete) a single 200m CPU / 500Mi memory pod is more than enough.

### 3.1 Default endpoint

| Config | Default | Where it points |
| --- | --- | --- |
| `TELEMETRY_OTLP_ENDPOINT` | `victorialogs:9428` | The `Service` defined in `install/victorialogs.yaml`. |
| `TELEMETRY_OTLP_URL_PATH` | `/insert/opentelemetry/v1/logs` | VictoriaLogs' OTLP/HTTP ingestion path. |
| `TELEMETRY_OTLP_INSECURE` | `true` | In-cluster traffic; no TLS. |

To send events to a different OTLP backend (Grafana Loki via OTLP collector, Tempo, Datadog, Honeycomb, etc.) override these three env vars. No code change is needed — the agent-sandbox process just speaks vanilla OTLP/HTTP.

### 3.2 Installing VictoriaLogs

```bash
kubectl apply -f install/victorialogs.yaml
```

This creates:

- `StatefulSet/victorialogs` — one replica, `victoriametrics/victoria-logs:v1.13.0-victorialogs`.
- `Service/victorialogs` ClusterIP on port `9428`.
- A 10Gi `PersistentVolumeClaim` via `volumeClaimTemplates`. Resize by editing the template before apply.
- 30-day retention by default (`-retentionPeriod=30d`).

Query the data:

```bash
# Tail the last 5 minutes of sandbox.create events
curl -s 'http://victorialogs:9428/select/logsql/query' \
  --data-urlencode 'query=event:"sandbox.create" _time:5m' | jq

# Per-user create count, last 1 day
curl -s 'http://victorialogs:9428/select/logsql/stats_query' \
  --data-urlencode 'query=event:"sandbox.create" _time:1d | stats by (user_key) count() as n'
```

### 3.3 Why not metrics

Why logs and not metrics:
- High-cardinality user / sandbox IDs blow up Prometheus label space.
- We still want to derive counters and histograms — those are computed downstream from the log stream (LogsQL `stats by` in VictoriaLogs, or a recording rule in whatever backend operators swap in) rather than by the agent-sandbox process.

Counters and histograms are derived downstream from the log stream (LogsQL `stats by ...` in VictoriaLogs), not emitted as Prometheus metrics from agent-sandbox. This keeps the agent process free of unbounded label cardinality and avoids a second telemetry path.

## 4. Integration Points

### 4.1 Telemetry emitter

A small wrapper in `pkg/telemetry` exposes:

```go
type CreateEvent struct {
    UserKey      string
    SandboxID    string
    SandboxName  string
    Template     string
    App          string
    FromPool     bool
    AutoPause    bool
    Success      bool
    ErrorMessage string
    DurationMS   int64
}

type DeleteEvent struct {
    UserKey       string
    SandboxID     string
    SandboxName   string
    Template      string
    App           string
    FromPool      bool
    AutoPause     bool
    CreatedAt     time.Time
    DeletedAt     time.Time
    AliveSeconds  int64
    Reason        string
    Success       bool
    ErrorClass    string
    ErrorMessage  string
}

func EmitCreate(e CreateEvent)
func EmitDelete(e DeleteEvent)
```

Both functions are non-blocking. They push to a bounded in-process channel (default size `1024`); if the channel is full, the event is dropped and an internal `telemetry_drop_total` counter is incremented. A single background goroutine drains the channel and forwards records to the OTel log exporter and the Prometheus counters.

### 4.2 Create call site

Single emit site: `Controller.Create` in `pkg/sandbox/controller.go`. The event is built at function entry from `Sandbox.User / ID / Name / Template / App`, populated as the function progresses (`FromPool`, `ErrorMessage`, `Success`), and emitted once via `defer` before return. Both the native and E2B handlers funnel through this method, so we get one event per attempted sandbox lifecycle without per-API duplication.

Upstream caller failures (rate-limit reject, request decode, name conflict, validation) never reach `Controller.Create` and are deliberately excluded — they are HTTP-layer concerns, not sandbox lifecycle events. Track them via HTTP access logs / capacity status APIs.

`success` is true only when `Controller.Create` returns no error and the sandbox reached `Running`. Pool-acquire failure and ready-wait timeout both produce `success=false` with the underlying error in `error_message`.

### 4.3 Delete call sites

- `pkg/sandbox/controller.go`: add `DeleteWithReason(name, reason string)` and route existing `Delete`, `DeleteByID`, `DeleteByTemplateName` through it. Reason defaults to `unknown` only at the lowest layer to surface missing instrumentation upstream.
- `pkg/scaler/timeout_scaler.go`: pass `timeout`.
- `pkg/scaler/idle_scaler.go`: pass `idle_timeout`, or `pause_failed_fallback` when delete follows a failed pause.
- User-initiated delete handlers: pass `user_request`.
- `DeleteByTemplateName`: pass `template_cleanup`.

Before issuing the K8s delete, the call site reads `Sandbox.CreatedAt`, the pause / resume annotations, and the labels needed for the event, so the data is captured even if the underlying object is gone by the time the event is emitted.

### 4.4 Live duration

`alive_seconds = deleted_at - created_at` from `Sandbox.CreatedAt`. Paused time is included — we do not subtract it out. Operators who want active-only time can compute it downstream by correlating with pause/resume events if those are instrumented separately.

## 5. Configuration

Telemetry config lives on `config.Cfg.Telemetry`.

```go
type TelemetryConfig struct {
    Enabled      bool    `split_words:"true" default:"false"`
    OTLPEndpoint string  `split_words:"true" default:"victorialogs:9428"`
    OTLPURLPath  string  `split_words:"true" default:"/insert/opentelemetry/v1/logs"`
    OTLPInsecure bool    `split_words:"true" default:"false"`
    BufferSize   int     `split_words:"true" default:"1024"`
    SampleRate   float64 `split_words:"true" default:"1.0"`
}
```

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `TELEMETRY_ENABLED` | `false` | Master switch. When false, `EmitCreate` / `EmitDelete` return immediately. |
| `TELEMETRY_OTLP_ENDPOINT` | `victorialogs:9428` | OTLP/HTTP endpoint host:port. Default points at the in-cluster VictoriaLogs service. |
| `TELEMETRY_OTLP_URL_PATH` | `/insert/opentelemetry/v1/logs` | OTLP/HTTP request path. Default is VictoriaLogs' OTLP ingestion path. |
| `TELEMETRY_OTLP_INSECURE` | `false` | Use HTTP instead of HTTPS. Set to `true` for in-cluster traffic to the default VictoriaLogs service. |
| `TELEMETRY_BUFFER_SIZE` | `1024` | Bounded channel size. |
| `TELEMETRY_SAMPLE_RATE` | `1.0` | Sample rate in `[0, 1]` applied uniformly to `sandbox.create` and `sandbox.delete`. Sampling happens after event construction. |

## 6. Privacy

`user_key` is the only PII-adjacent field. It is emitted as the **leading 2/3** of `Sandbox.User`. The prefix is long enough to group events by tenant in dashboards but drops the trailing portion (typically a UUID suffix or random token tail), so the full owner key is never written to the log backend. Example: `testuser-aef134ef-7aa1-945e-9399-7df9a4ad0c3f` (length 49) is emitted as `testuser-aef134ef-7aa1-945e-9399-7d` (length 32). The transformation is unconditional and not configurable — there is no hash key to manage and no random salt that could destabilize aggregations across restarts.

## 7. Graceful Degradation

| Scenario | Behavior |
| --- | --- |
| `Telemetry.Enabled == false` | `EmitCreate` / `EmitDelete` are no-ops. |
| Exporter init fails | One warning logged. Emitter still runs and increments Prometheus counters; OTel records are dropped. |
| Buffer full | Event dropped; `telemetry_drop_total` incremented; no log spam (rate-limited warning). |
| OTel exporter blocked / slow | Exporter has its own queue and timeout. Drainer goroutine never blocks the request path. |
| Missing `created_at` | `alive_seconds = -1`; `error_class` stays unaffected. Surfaces upstream data loss. |
| Missing `reason` | Emitted as `unknown`. Should be alerted on if `unknown` rate > 0. |

## 8. Test Plan

### 8.1 Unit tests

- `EmitCreate` / `EmitDelete` are non-blocking when the buffer is full.
- `user_key` masking returns the leading 2/3 of the input and is empty for empty input.
- Sample rate `0` emits no log records but still increments counters.
- `alive_seconds` computation: positive for normal lifetimes, `-1` when `created_at` is missing.
- `reason=unknown` only appears when no upstream reason is provided.

### 8.2 Integration tests

- Native create success / failure emit one event each with the correct `api=native` and `error_class`.
- E2B create emits with `api=e2b`.
- Rate-limit `413` / `429` rejects emit a create event with `success=false` and the matching `error_class`.
- Timeout scaler delete emits `reason=timeout`; idle scaler delete emits `reason=idle_timeout`; user API delete emits `reason=user_request`.
- Pause-then-delete emits exactly one `sandbox.delete` (no `sandbox.create` replay).
- Prometheus counters match the number of emitted log records over the test run (modulo sampling).

## 9. Out of Scope

- Pause / resume events (already partially observable via annotations and k8s events).
- Per-request HTTP-level telemetry (latency, status). That is a separate proposal.
- Cumulative paused time across multiple pause / resume cycles.
- Cost / billing aggregation. This proposal only emits raw lifecycle events; aggregation is a downstream concern.

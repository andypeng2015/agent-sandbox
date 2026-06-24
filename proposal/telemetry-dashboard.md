# Telemetry Dashboard

## 1. Goal

Render an in-product observability page that visualizes the `sandbox.create` / `sandbox.delete` events stored in VictoriaLogs by the telemetry pipeline (see `proposal/telemetry.md`). The page answers:

- How many sandboxes are being created over time? Per user?
- Which users / templates are driving volume?
- How long do creates take (`duration_ms`)?
- How long do sandboxes live (`alive_seconds`)?

Two filter dimensions are surfaced as URL query params and React state: **time range** and **user key**.

## 2. Data source

VictoriaLogs is queried via its LogsQL HTTP API:

| Endpoint | Use |
| --- | --- |
| `GET /select/logsql/stats_query_range` | Time-bucketed counts and aggregations. Returns Prometheus-style range vectors. |
| `GET /select/logsql/stats_query` | Single-point aggregations (totals over a window). |
| `GET /select/logsql/query` | Raw log lookups when a chart drills into individual events (out of scope for v1). |

LogsQL examples we will use:

```text
# Create count, bucketed by 1h, last 24h
event:"sandbox.create" _time:24h | stats by (_time:1h) count() as n

# Per-user creates, last 24h, top 10
event:"sandbox.create" _time:24h | stats by (user_key) count() as n | sort by (n desc) | limit 10

# Per-user creates over time
event:"sandbox.create" user_key:"testuser-a" _time:24h | stats by (_time:1h) count() as n

# Duration percentiles (create)
event:"sandbox.create" success:true _time:24h | stats quantile(0.5, duration_ms) as p50, quantile(0.9, duration_ms) as p90, quantile(0.99, duration_ms) as p99

# Alive-seconds histogram, bucketed
event:"sandbox.delete" _time:7d | stats by (
    histogram(alive_seconds, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 86400)
  ) count() as n
```

VictoriaLogs sits behind the in-cluster `victorialogs:9428` Service. The agent-sandbox process is the only client; the browser never talks to VictoriaLogs directly.

## 3. Architecture

```
Browser
   │ /api/v1/telemetry/...
   ▼
agent-sandbox (Go handler)
   │ /select/logsql/stats_query_range
   ▼
VictoriaLogs
```

Why proxy instead of CORS-enabling VictoriaLogs:

- **Single auth surface.** Browser already authenticates against agent-sandbox via `X-Api-Key`. VictoriaLogs has no auth at this default deployment.
- **Allow-listed queries.** The proxy builds LogsQL server-side from a small set of typed parameters, so the browser cannot run arbitrary queries against the log store.
- **Stable schema.** If we switch backends later (Loki, ClickHouse), only the proxy needs to change.

## 4. Backend API

All routes live under `/api/v1/telemetry`. Each returns the standard `{code, data, error}` envelope.

### 4.0 `GET /api/v1/telemetry/status`

Reports whether telemetry is wired up. The frontend hits this first; if `enabled=false`, it renders the setup wizard (see 5.5) instead of the charts.

Response:

```json
{
  "code": "0",
  "data": {
    "enabled": false,
    "otlp_endpoint": "victorialogs:9428",
    "otlp_url_path": "/insert/opentelemetry/v1/logs",
    "otlp_insecure": false,
    "install_yaml_path": "install/victorialogs.yaml"
  }
}
```

This endpoint is callable even when `TELEMETRY_ENABLED=false` — it has to be, since its purpose is to drive the onboarding flow. It does **not** probe the VictoriaLogs backend; if the backend is down or misconfigured the individual chart queries (4.1–4.4) will surface that as their own error, which the frontend renders inline per chart (see 5.6).

### 4.1 `GET /api/v1/telemetry/summary`

Returns single-window scalars for the headline KPI cards.

Query params:

| Param | Default | Notes |
| --- | --- | --- |
| `since` | `24h` | LogsQL `_time` duration. Whitelisted: `1h`, `6h`, `24h`, `7d`, `30d`. |
| `user_key` | empty | Optional filter; substring match in LogsQL using `user_key:"<prefix>*"`. |

Response:

```json
{
  "code": "0",
  "data": {
    "since": "24h",
    "create_total": 1287,
    "create_success": 1240,
    "create_failed": 47,
    "delete_total": 1102,
    "active_now": 185,
    "p50_duration_ms": 312,
    "p90_duration_ms": 1240,
    "p99_duration_ms": 4500,
    "p50_alive_seconds": 480,
    "p90_alive_seconds": 1800
  }
}
```

`active_now` = `create_success - delete_total` over the window (best-effort; not authoritative — `GET /api/v1/sandbox` is the source of truth for live count).

### 4.2 `GET /api/v1/telemetry/timeseries`

Time-bucketed counts for line charts.

| Param | Default | Notes |
| --- | --- | --- |
| `since` | `24h` | Same allow-list. |
| `step` | derived | Bucket width. Auto-pick: `1h` for ≤24h, `6h` for ≤7d, `1d` for ≤30d. Override via param. |
| `user_key` | empty | Optional. |
| `event` | `create` | `create` or `delete`. |
| `group_by` | empty | Optional: `template`, `reason`, `success`, `from_pool`. |

Response (no group_by):

```json
{
  "code": "0",
  "data": {
    "step": "1h",
    "buckets": [
      {"t": "2026-06-07T10:00:00Z", "n": 42},
      {"t": "2026-06-07T11:00:00Z", "n": 51}
    ]
  }
}
```

Response (with group_by, e.g. `reason`):

```json
{
  "code": "0",
  "data": {
    "step": "1h",
    "series": [
      {"name": "user_request", "points": [{"t": "...", "n": 20}, ...]},
      {"name": "timeout",      "points": [{"t": "...", "n": 12}, ...]},
      {"name": "idle_timeout", "points": [...]}
    ]
  }
}
```

### 4.3 `GET /api/v1/telemetry/by_user`

Top-N user breakdown for the horizontal-bar "leaderboard" chart.

| Param | Default | Notes |
| --- | --- | --- |
| `since` | `24h` | |
| `event` | `create` | `create` or `delete`. |
| `top` | `10` | Capped at `50`. |

Response:

```json
{
  "code": "0",
  "data": {
    "users": [
      {"user_key": "testuser-aef...", "n": 380},
      {"user_key": "vip-user-xxx...", "n": 245}
    ]
  }
}
```

### 4.4 `GET /api/v1/telemetry/durations`

Histogram buckets for "create duration" and "alive seconds" charts.

| Param | Default | Notes |
| --- | --- | --- |
| `since` | `24h` | |
| `user_key` | empty | |
| `metric` | `duration_ms` | `duration_ms` (from create) or `alive_seconds` (from delete). |

Response:

```json
{
  "code": "0",
  "data": {
    "metric": "duration_ms",
    "buckets": [
      {"le": 100,   "n": 320},
      {"le": 500,   "n": 540},
      {"le": 1000,  "n": 180},
      {"le": 5000,  "n": 95},
      {"le": null,  "n": 12}
    ],
    "p50": 312,
    "p90": 1240,
    "p99": 4500
  }
}
```

### 4.5 Config / safety rails

- All routes require the same `X-Api-Key` auth middleware as other admin pages.
- Time-range and step values come from a fixed allow-list, so a hostile client can't craft an unbounded query.
- `user_key` is escaped before being injected into LogsQL (double-quoted, special chars stripped). The proxy never trusts the query param verbatim.
- The LogsQL host URL is derived from `TELEMETRY_OTLP_ENDPOINT` as `http://<OTLPEndpoint>`. We do not add a separate `TELEMETRY_QUERY_ENDPOINT` knob — the default in-cluster VictoriaLogs deployment serves both OTLP ingestion and LogsQL queries on the same `victorialogs:9428` host over plain HTTP. Operators terminating TLS in front of VictoriaLogs are expected to point both ingestion and query traffic at their gateway.

## 5. Frontend

### 5.1 New page

- File: `ui/src/pages/MetricsPage.tsx`.
- Route: `/metrics` (added in `ui/src/router/index.tsx`).
- Sidebar nav entry: "Metrics" under the existing Dashboard section.

### 5.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Time range: [ 1h | 6h | 24h | 7d | 30d ]    User: [______]  │
├──────────────────────────────────────────────────────────────┤
│  [Creates]  [Success rate]  [P50 duration]  [P50 alive time] │  ← KPI cards
├──────────────────────────────────────────────────────────────┤
│  Sandbox create trend (line)                                 │  ← /timeseries event=create
├──────────────────────────────────────────────────────────────┤
│  Delete trend by reason (stacked area)                       │  ← /timeseries event=delete group_by=reason
├──────────────────────────────────────────────────────────────┤
│  Top users by creates (horizontal bar)  │ Per-user trend     │
│                                          │ (multi-line; rows  │
│                                          │  clickable to set  │
│                                          │  user filter)      │
├──────────────────────────────────────────────────────────────┤
│  Create duration histogram (bar)        │ Alive seconds      │
│  + P50/P90/P99 annotations              │ histogram (bar)    │
└──────────────────────────────────────────────────────────────┘
```

Time range and user key are stored in the URL query string (`?since=24h&user=testuser-a`) so a chart link is shareable.

### 5.3 Charting library

`react-chartjs-2` + `chart.js` are added to `ui/package.json` as runtime deps. We use:

- `Line` for trend lines and stacked areas (via `fill: 'origin'`).
- `Bar` (horizontal) for the top-users leaderboard.
- `Bar` (vertical) for histograms.

No date-fns adapter is needed — buckets come back as ISO strings from the backend; we convert to `Date` once at fetch time. If we later want hover-aware time axes we can add `chartjs-adapter-date-fns`, but the v1 axis is category-based (one tick per bucket).

### 5.4 Data fetching

A thin `ui/src/lib/api/telemetry.ts` mirrors the backend shape:

```ts
export type StatusData = {
  enabled: boolean
  otlp_endpoint: string
  otlp_url_path: string
  otlp_insecure: boolean
  install_yaml_path: string
}

export async function getStatus(): Promise<StatusData>
export async function getSummary(p: { since: string; userKey?: string }): Promise<SummaryData>
export async function getTimeseries(p: { since: string; step?: string; event: 'create' | 'delete'; groupBy?: string; userKey?: string }): Promise<TimeseriesData>
export async function getByUser(p: { since: string; event: 'create' | 'delete'; top?: number }): Promise<ByUserData>
export async function getDurations(p: { since: string; metric: 'duration_ms' | 'alive_seconds'; userKey?: string }): Promise<DurationsData>
```

Fetch order on page mount and on filter change:

1. `getStatus()` always runs first.
2. If `status.enabled === false`, the page renders the setup wizard (5.5) and skips the rest.
3. Otherwise, the four data calls run in parallel (`Promise.all`). If any of them fail, that chart shows an inline error (5.6) — the wizard does not re-appear.

There is no auto-refresh in v1; a manual "Refresh" button next to the time-range chips covers it. The setup wizard's "Check again" button calls `getStatus()` only.

### 5.5 Setup wizard (telemetry disabled)

When `/telemetry/status` reports `enabled=false`, the Metrics page renders a guided setup screen in place of the charts. The intent is that an operator who lands on the page can finish enabling the feature without leaving the UI.

Layout:

```
┌───────────────────────────────────────────────────────────────┐
│  Metrics                                                       │
├───────────────────────────────────────────────────────────────┤
│  ⚠  Telemetry is not enabled                                  │
│                                                                │
│  Finish the steps below to start collecting sandbox            │
│  lifecycle data.                                               │
│                                                                │
│  ┌─ Step 1: Install VictoriaLogs ──────────────────────┐      │
│  │                                                       │      │
│  │   kubectl apply -f install/victorialogs.yaml          │      │
│  │   [Copy]   [Open YAML]                                │      │
│  └───────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌─ Step 2: Set telemetry env vars on agent-sandbox ────┐     │
│  │                                                       │      │
│  │   TELEMETRY_ENABLED=true                              │      │
│  │   TELEMETRY_OTLP_ENDPOINT=victorialogs:9428           │      │
│  │   TELEMETRY_OTLP_URL_PATH=/insert/opentelemetry/v1/logs│     │
│  │   TELEMETRY_OTLP_INSECURE=true                        │      │
│  │   [Copy all]                                          │      │
│  │                                                       │      │
│  │   Then restart the agent-sandbox Deployment.          │      │
│  └───────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌─ Step 3: Verify ────────────────────────────────────┐      │
│  │                                                       │      │
│  │   [Check again]                                       │      │
│  │   Last checked: 16:42:01                              │      │
│  └───────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────┘
```

State machine:

- `enabled=false` → wizard renders, charts skipped.
- `enabled=true` → wizard hidden, charts render. If VictoriaLogs is unreachable at that point, each chart surfaces its own error inline (see 5.6) rather than reverting to the wizard. That keeps the two failure modes separate: "operator hasn't set it up" vs "backend is having a bad day".

Implementation notes:

- The "Open YAML" link is a relative anchor (`/install/victorialogs.yaml` served as a static file under the existing UI dist mount, or just an external GitHub link — TBD during implementation; static is preferred so air-gapped installs still work).
- All command blocks support Copy via the existing daisyUI button + `navigator.clipboard.writeText` pattern used elsewhere in the UI.
- "Check again" simply re-fetches `/telemetry/status`. No page reload.
- We do **not** offer an in-UI "enable telemetry" button. Env vars are part of the agent-sandbox Deployment spec; flipping them at runtime via an API would create a config-source split-brain with the operator's manifests. Showing the values to copy is the right level of help.

### 5.6 Per-chart error fallback

When telemetry **is** enabled, individual chart queries can still fail (VictoriaLogs unreachable, LogsQL error, network blip). Each chart catches its own error and renders an inline "Failed to load — retry" affordance with the raw error message; the rest of the page keeps working. This is also the path that surfaces a misconfigured `OTLP_ENDPOINT` after the operator has flipped `TELEMETRY_ENABLED=true`.

## 6. Performance

Per filter change:

- 4 backend calls (summary, 2x timeseries, by_user, durations).
- Each backend call is one LogsQL aggregation. VictoriaLogs returns these in single-digit ms for our event volumes.
- Buckets cap: `step=1h` over `30d` is 720 points; well within `react-chartjs-2`'s comfort zone.

No frontend caching layer in v1. If we revisit, a 30-second SWR cache keyed on `(since, user_key, event, group_by, step)` would suffice.

## 7. Out of scope (v1)

- Raw event drill-down table.
- Cost / billing aggregation per user (downstream concern).
- Alerts. Use VictoriaLogs `vmalert` or the operator's existing alerting stack.
- Per-template or per-pool dashboards. Add as future tabs on the same page.
- Auto-refresh / live tail.

## 8. Test plan

- Backend: table-driven tests for the LogsQL builder (time-range allow-list, user-key escaping, group_by normalization). Integration test with a real single-instance VictoriaLogs pod.
- Frontend: visual smoke test via dev server with the VictoriaLogs install YAML applied. Verify URL-state roundtrip (refresh keeps filters), empty state when `TELEMETRY_ENABLED=false`, single-chart-error path.

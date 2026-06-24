import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  RadialLinearScale,
  Title,
  Tooltip,
} from 'chart.js'
import { Bar, Line, PolarArea } from 'react-chartjs-2'

import TelemetryRangeControls from '../components/common/TelemetryRangeControls'
import {
  TELEMETRY_TIME_RANGES,
  getTelemetryByUser,
  getTelemetryDurations,
  getTelemetryStatus,
  getTelemetrySummary,
  getTelemetryTimeseries,
  type TelemetryByUserData,
  type TelemetryDurationsData,
  type TelemetryStatusData,
  type TelemetrySummaryData,
  type TelemetryTimeRange,
  type TelemetryTimeseriesData,
} from '../lib/api/telemetry'

ChartJS.register(
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
)

const STACKED_REASON_COLORS: Record<string, string> = {
  api_request: '#3b82f6',
  e2b_sdk: '#22c55e',
  mcp: '#f59e0b',
  timeout: '#ef4444',
  idle_timeout: '#f97316',
  pause_failed_fallback: '#a855f7',
  template_cleanup: '#06b6d4',
  admin: '#64748b',
  unknown: '#9ca3af',
}
// Distinct palette for the per-user trend lines. Cycled when there are more
// users than colors; users beyond MAX_TREND_LINES are dropped.
const TREND_PALETTE = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7',
    '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f97316',
]

function colorFor(name: string): string {
  return STACKED_REASON_COLORS[name] ?? '#6b7280'
}

// Backend caps top at 50 today; if we want truly "all users" the backend can
// raise this. 50 is generous for a single-tenant deployment.
const maxByUserTop = 50

const REFRESH_INTERVAL_OPTIONS_MS = [30_000, 60_000, 120_000, 300_000, 600_000]
const DEFAULT_REFRESH_INTERVAL_MS = 120_000

function formatRefreshInterval(ms: number): string {
  if (ms < 60_000) return `${ms / 1000}s`
  return `${ms / 60_000}m`
}

function defaultRange(): TelemetryTimeRange {
  return '24h'
}

function isRange(v: string | null): v is TelemetryTimeRange {
  return v !== null && (TELEMETRY_TIME_RANGES as readonly string[]).includes(v)
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return String(Math.round(n))
}

// All duration-style values from the backend are now seconds (operation
// duration on create, sandbox lifetime on delete).
function formatDuration(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`
  if (s < 60) return `${s.toFixed(1)} s`
  if (s < 3600) return `${(s / 60).toFixed(1)} min`
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`
  return `${(s / 86400).toFixed(1)} d`
}

function formatBucketLabel(le: number | null): string {
  if (le === null) return '+∞'
  return `≤ ${formatDuration(le)}`
}

function formatBucketTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type ChartState<T> = {
  data: T | null
  loading: boolean
  error: string
}

const emptyChartState = <T,>(): ChartState<T> => ({ data: null, loading: true, error: '' })

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

export default function MetricsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const range = isRange(searchParams.get('since')) ? (searchParams.get('since') as TelemetryTimeRange) : defaultRange()
  const userKey = searchParams.get('user') ?? ''
  const startISO = searchParams.get('start') ?? ''
  const endISO = searchParams.get('end') ?? ''

  const [userKeyInput, setUserKeyInput] = useState(userKey)
  useEffect(() => {
    setUserKeyInput(userKey)
  }, [userKey])

  const [status, setStatus] = useState<TelemetryStatusData | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState('')

  const [summary, setSummary] = useState<ChartState<TelemetrySummaryData>>(emptyChartState)
  const [createTrend, setCreateTrend] = useState<ChartState<TelemetryTimeseriesData>>(emptyChartState)
  const [deleteTrend, setDeleteTrend] = useState<ChartState<TelemetryTimeseriesData>>(emptyChartState)
  const [byUser, setByUser] = useState<ChartState<TelemetryByUserData>>(emptyChartState)
  const [byUserTrend, setByUserTrend] = useState<ChartState<TelemetryTimeseriesData>>(emptyChartState)
  const [durationHist, setDurationHist] = useState<ChartState<TelemetryDurationsData>>(emptyChartState)
  const [aliveHist, setAliveHist] = useState<ChartState<TelemetryDurationsData>>(emptyChartState)

  const [isAutoRefresh, setIsAutoRefresh] = useState(true)
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(DEFAULT_REFRESH_INTERVAL_MS)

  const setFilters = useCallback(
    (next: {
      since?: TelemetryTimeRange
      startISO?: string
      endISO?: string
      userKey?: string
    }) => {
      const params = new URLSearchParams(searchParams)
      if (next.since !== undefined) {
        params.set('since', next.since)
        // Selecting a preset clears any custom range.
        params.delete('start')
        params.delete('end')
      }
      if (next.startISO !== undefined || next.endISO !== undefined) {
        const s = next.startISO ?? startISO
        const e = next.endISO ?? endISO
        if (s && e) {
          params.set('start', s)
          params.set('end', e)
        } else {
          params.delete('start')
          params.delete('end')
        }
      }
      if (next.userKey !== undefined) {
        if (next.userKey.trim() === '') {
          params.delete('user')
        } else {
          params.set('user', next.userKey.trim())
        }
      }
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams, startISO, endISO]
  )

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError('')
    try {
      const data = await getTelemetryStatus()
      setStatus(data)
    } catch (err) {
      setStatusError(errorMessage(err))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const loadCharts = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setSummary({ data: null, loading: true, error: '' })
      setCreateTrend({ data: null, loading: true, error: '' })
      setDeleteTrend({ data: null, loading: true, error: '' })
      setByUser({ data: null, loading: true, error: '' })
      setByUserTrend({ data: null, loading: true, error: '' })
      setDurationHist({ data: null, loading: true, error: '' })
      setAliveHist({ data: null, loading: true, error: '' })
    }

    const rangeParams = {
      since: range,
      startISO: startISO || undefined,
      endISO: endISO || undefined,
    }

    void getTelemetrySummary({ ...rangeParams, userKey: userKey || undefined })
      .then((d) => setSummary({ data: d, loading: false, error: '' }))
      .catch((e) => setSummary({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryTimeseries({ ...rangeParams, event: 'create', userKey: userKey || undefined })
      .then((d) => setCreateTrend({ data: d, loading: false, error: '' }))
      .catch((e) => setCreateTrend({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryTimeseries({ ...rangeParams, event: 'delete', groupBy: 'reason', userKey: userKey || undefined })
      .then((d) => setDeleteTrend({ data: d, loading: false, error: '' }))
      .catch((e) => setDeleteTrend({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryByUser({ ...rangeParams, event: 'create', top: maxByUserTop })
      .then((d) => setByUser({ data: d, loading: false, error: '' }))
      .catch((e) => setByUser({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryTimeseries({ ...rangeParams, event: 'create', groupBy: 'user_key', userKey: userKey || undefined })
      .then((d) => setByUserTrend({ data: d, loading: false, error: '' }))
      .catch((e) => setByUserTrend({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryDurations({ ...rangeParams, metric: 'duration_seconds', userKey: userKey || undefined })
      .then((d) => setDurationHist({ data: d, loading: false, error: '' }))
      .catch((e) => setDurationHist({ data: null, loading: false, error: errorMessage(e) }))

    void getTelemetryDurations({ ...rangeParams, metric: 'alive_seconds', userKey: userKey || undefined })
      .then((d) => setAliveHist({ data: d, loading: false, error: '' }))
      .catch((e) => setAliveHist({ data: null, loading: false, error: errorMessage(e) }))
  }, [range, startISO, endISO, userKey])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (status?.enabled) {
      void loadCharts()
    }
  }, [status?.enabled, loadCharts])

  useEffect(() => {
    if (!status?.enabled || !isAutoRefresh) return
    const timer = window.setInterval(() => {
      void loadCharts({ silent: true })
    }, refreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [status?.enabled, isAutoRefresh, refreshIntervalMs, loadCharts])

  const envBlock = useMemo(() => {
    if (!status) return ''
    return [
      'TELEMETRY_ENABLED=true',
      `TELEMETRY_OTLP_ENDPOINT=${status.otlp_endpoint || 'victorialogs:9428'}`,
      `TELEMETRY_OTLP_URL_PATH=${status.otlp_url_path || '/insert/opentelemetry/v1/logs'}`,
      `TELEMETRY_OTLP_INSECURE=${status.otlp_insecure ? 'true' : 'false'}`,
    ].join('\n')
  }, [status])

  if (statusLoading) {
    return (
      <>
        <MetricsHeader description="Loading…" />
        <div className="mt-4 flex items-center gap-2 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-sm" /> Loading telemetry status…
        </div>
      </>
    )
  }

  if (statusError) {
    return (
      <>
        <MetricsHeader description="Failed to load telemetry status." />
        <div className="mt-4 alert alert-error">
          <span>{statusError}</span>
        </div>
      </>
    )
  }

  if (!status?.enabled) {
    return <SetupWizard status={status} envBlock={envBlock} onRefresh={loadStatus} />
  }

  return (
    <>
      <MetricsHeader description="Sandbox creation and deletion statistics from the telemetry pipeline.">
        <TelemetryRangeControls
          since={range}
          startISO={startISO}
          endISO={endISO}
          onSelectPreset={(s) => setFilters({ since: s })}
          onApplyCustom={(s, e) => setFilters({ startISO: s, endISO: e })}
          onClearCustom={() => setFilters({ startISO: '', endISO: '' })}
        />
        <FiltersBar
          userKeyInput={userKeyInput}
          onUserKeyInputChange={setUserKeyInput}
          onApplyUserKey={() => setFilters({ userKey: userKeyInput })}
          onClearUserKey={() => {
            setUserKeyInput('')
            setFilters({ userKey: '' })
          }}
          onRefresh={() => {
            void loadCharts()
          }}
          isAutoRefresh={isAutoRefresh}
          onAutoRefreshChange={setIsAutoRefresh}
          refreshIntervalMs={refreshIntervalMs}
          onRefreshIntervalChange={setRefreshIntervalMs}
        />
      </MetricsHeader>

      <div className="mt-4 space-y-4">
        <KPICards data={summary.data} loading={summary.loading} error={summary.error} />

        <ChartCard title="Sandbox creates" error={createTrend.error} loading={createTrend.loading}>
          {createTrend.data && <CreateTrendChart data={createTrend.data} />}
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title="Creates by user" error={byUser.error} loading={byUser.loading}>
            {byUser.data && (
              <ByUserChart
                data={byUser.data}
                onSelect={(uk) => {
                  setUserKeyInput(uk)
                  setFilters({ userKey: uk })
                }}
              />
            )}
          </ChartCard>
            <ChartCard title="Sandbox deletes by reason" error={deleteTrend.error} loading={deleteTrend.loading}>
                {deleteTrend.data && <DeleteTrendChart data={deleteTrend.data} />}
            </ChartCard>
        </div>

        <ChartCard title="Creates by user (trend)" error={byUserTrend.error} loading={byUserTrend.loading}>
          {byUserTrend.data && (
            <ByUserTrendChart
              data={byUserTrend.data}
              topUsers={byUser.data?.users.map((u) => u.user_key) ?? []}
            />
          )}
        </ChartCard>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title="Create duration (ms)" error={durationHist.error} loading={durationHist.loading}>
            {durationHist.data && <HistogramChart data={durationHist.data} />}
          </ChartCard>
          <ChartCard title="Sandbox alive time" error={aliveHist.error} loading={aliveHist.loading}>
            {aliveHist.data && <HistogramChart data={aliveHist.data} />}
          </ChartCard>
        </div>
      </div>
    </>
  )
}

// --- Page header -------------------------------------------------------------

function MetricsHeader({
  description,
  children,
}: {
  description: string
  children?: React.ReactNode
}) {
  return (
    <header className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Metrics</h2>
          <p className="text-sm text-base-content/70">{description}</p>
        </div>
        {children}
      </div>
    </header>
  )
}

// --- Filter bar --------------------------------------------------------------

type FiltersBarProps = {
  userKeyInput: string
  onUserKeyInputChange: (v: string) => void
  onApplyUserKey: () => void
  onClearUserKey: () => void
  onRefresh: () => void
  isAutoRefresh: boolean
  onAutoRefreshChange: (v: boolean) => void
  refreshIntervalMs: number
  onRefreshIntervalChange: (ms: number) => void
}

function FiltersBar({
  userKeyInput,
  onUserKeyInputChange,
  onApplyUserKey,
  onClearUserKey,
  onRefresh,
  isAutoRefresh,
  onAutoRefreshChange,
  refreshIntervalMs,
  onRefreshIntervalChange,
}: FiltersBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
        UserKey:
        <div className="join">
        <input
          type="text"
          placeholder="Filter by user key…"
          className="input input-sm input-bordered join-item w-80"
          value={userKeyInput}
          onChange={(e) => onUserKeyInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApplyUserKey()
          }}
        />
        <button className="btn btn-sm join-item " onClick={onApplyUserKey}>
          Apply
        </button>
        {userKeyInput && (
          <button className="btn btn-sm join-item btn-ghost" onClick={onClearUserKey}>
            Clear
          </button>
        )}
      </div>

      <div className="flex-1" />

      <label className="label cursor-pointer gap-2 py-0">
        <span className="label-text text-sm">Auto refresh</span>
        <input
          type="checkbox"
          className="toggle toggle-sm"
          checked={isAutoRefresh}
          onChange={(e) => onAutoRefreshChange(e.target.checked)}
        />
      </label>
      <select
        className="select select-sm select-bordered  w-20"
        value={String(refreshIntervalMs)}
        disabled={!isAutoRefresh}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10)
          if (!Number.isNaN(n) && n > 0) onRefreshIntervalChange(n)
        }}
      >
        {REFRESH_INTERVAL_OPTIONS_MS.map((ms) => (
          <option key={ms} value={ms}>
            {formatRefreshInterval(ms)}
          </option>
        ))}
      </select>

      <button className="btn btn-sm  " onClick={onRefresh}>
        Refresh
      </button>
    </div>
  )
}

// --- KPI cards ---------------------------------------------------------------

type KPICardsProps = {
  data: TelemetrySummaryData | null
  loading: boolean
  error: string
}

function KPICards({ data, loading, error }: KPICardsProps) {
  if (error) {
    return (
      <div className="alert alert-warning">
        <span>Failed to load summary: {error}</span>
      </div>
    )
  }

  const successRate =
    data && data.create_total > 0 ? Math.round((data.create_success / data.create_total) * 100) : 0

  return (
    <div className="stats stats-vertical w-full border border-base-300 bg-base-100 shadow-sm md:stats-horizontal">
      <KPI
        title="Sandboxes"
        value={data ? formatNumber(data.create_total) : '—'}
        desc={data ? `Total creates in this period (${data.create_total})` : ''}
        loading={loading}
        valueClass="text-primary"
      />
      <KPI
        title="Success rate"
        value={data ? `${successRate}%` : '—'}
        desc={data ? `${formatNumber(data.create_success)} / ${formatNumber(data.create_total)}` : ''}
        loading={loading}
      />
      <KPI
        title="P50 create duration"
        value={data ? formatDuration(data.p50_duration_seconds) : '—'}
        desc={data ? `P90 ${formatDuration(data.p90_duration_seconds)}` : ''}
        loading={loading}
      />
      <KPI
        title="P50 alive time"
        value={data ? formatDuration(data.p50_alive_seconds) : '—'}
        desc={data ? `P90 ${formatDuration(data.p90_alive_seconds)}` : ''}
        loading={loading}
      />
    </div>
  )
}

function KPI({
  title,
  value,
  desc,
  loading,
  valueClass,
}: {
  title: string
  value: string
  desc?: string
  loading?: boolean
  valueClass?: string
}) {
  return (
    <div className="stat">
      <div className="stat-title ">{title}</div>
      <div className={`stat-value text-3xl ${valueClass ?? ''}`}>
        {loading ? <span className="loading loading-spinner loading-sm" /> : value}
      </div>
      {desc && <div className="stat-desc">{desc}</div>}
    </div>
  )
}

// --- Chart card --------------------------------------------------------------

type ChartCardProps = {
  title: string
  loading: boolean
  error: string
  empty?: string
  children: React.ReactNode
}

function ChartCard({ title, loading, error, empty, children }: ChartCardProps) {
  return (
    <div className="card bg-base-100 shadow-sm">
      <div className="card-body p-4">
        <div className="mb-2 text-sm font-medium text-base-content/80">{title}</div>
        {loading ? (
          <div className="flex h-56 items-center justify-center text-sm text-base-content/60">
            <span className="loading loading-spinner loading-sm mr-2" /> Loading…
          </div>
        ) : error ? (
          <div className="alert alert-warning">
            <span>{error}</span>
          </div>
        ) : empty ? (
          <div className="flex h-56 items-center justify-center text-sm text-base-content/60">{empty}</div>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

// --- Charts ------------------------------------------------------------------

function CreateTrendChart({ data }: { data: TelemetryTimeseriesData }) {
  const points = data.buckets ?? []
  const chartData = {
    labels: points.map((p) => formatBucketTime(p.t)),
    datasets: [
      {
        label: 'Creates',
        data: points.map((p) => p.n),
        borderColor: '#f861b4',
        backgroundColor: '#f861b410',
        fill: true,
        tension: 0.3,
          pointHoverRadius: 15,
        pointRadius: 5,
      },
    ],
  }
  return (
    <div className="h-64">
      <Line data={chartData} options={lineOpts()} />
    </div>
  )
}

function DeleteTrendChart({ data }: { data: TelemetryTimeseriesData }) {
  const series = data.series ?? []
  if (series.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-base-content/60">No data</div>
  }

  // Merge timestamps across all reasons (VictoriaLogs returns sparse points
  // per group), then zero-fill each series so the stacked bars align.
  const timestampSet = new Set<string>()
  for (const s of series) {
    for (const p of s.points) timestampSet.add(p.t)
  }
  const timestamps = Array.from(timestampSet).sort()
  const labels = timestamps.map((t) => formatBucketTime(t))

  const datasets = series.map((s) => {
    const lookup = new Map(s.points.map((p) => [p.t, p.n]))
    return {
      label: s.name,
      data: timestamps.map((t) => lookup.get(t) ?? 0),
      backgroundColor: colorFor(s.name),
      borderColor: colorFor(s.name),
      stack: 'reasons',
    }
  })

  return (
    <div className="h-64">
      <Bar
        data={{ labels, datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: indexInteraction,
          plugins: {
            legend: { position: 'bottom' as const },
            tooltip: indexTooltip,
          },
          scales: {
            x: { stacked: true, ticks: { maxRotation: 0, autoSkip: true } },
            y: { stacked: true, beginAtZero: true },
          },
        }}
      />
    </div>
  )
}

// Polar area beyond ~10 segments becomes a blob; cap to the leaderboard's top.
const POLAR_TOP_N = 10

function ByUserChart({
  data,
  onSelect,
}: {
  data: TelemetryByUserData
  onSelect: (userKey: string) => void
}) {
  const users = data.users.slice(0, POLAR_TOP_N)
  if (users.length === 0) {
    return <div className="flex h-72 items-center justify-center text-sm text-base-content/60">No data</div>
  }

  const palette = users.map((_, i) => TREND_PALETTE[i % TREND_PALETTE.length])
  const chartData = {
    labels: users.map((u) => u.user_key || '(empty)'),
    datasets: [
      {
        label: 'Creates',
        data: users.map((u) => u.n),
        backgroundColor: palette.map((c) => withAlpha(c, 0.6)),
        borderColor: palette,
        borderWidth: 1,
      },
    ],
  }

  return (
    <div className="h-72">
      <PolarArea
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right' as const },
            tooltip: { intersect: true },
          },
          scales: {
            r: { beginAtZero: true, ticks: { display: false } },
          },
          onClick: (_evt, els) => {
            if (els.length === 0) return
            const idx = els[0].index
            const user = users[idx]?.user_key
            if (user) onSelect(user)
          },
        }}
      />
    </div>
  )
}

// withAlpha converts a `#rrggbb` into the matching `rgba(..., a)` string so
// PolarArea segments are translucent but their borders stay vivid.
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}


const MAX_TREND_LINES = TREND_PALETTE.length

function ByUserTrendChart({
  data,
  topUsers,
}: {
  data: TelemetryTimeseriesData
  topUsers: string[]
}) {
  const allSeries = data.series ?? []
  if (allSeries.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-base-content/60">No data</div>
  }

  // Keep only the leaderboard's top users to avoid an unreadable line jungle.
  // If we have no leaderboard yet, fall back to the first MAX_TREND_LINES series.
  const allowed =
    topUsers.length > 0 ? new Set(topUsers.slice(0, MAX_TREND_LINES)) : null
  const filtered = allowed
    ? allSeries.filter((s) => allowed.has(s.name))
    : allSeries.slice(0, MAX_TREND_LINES)

  if (filtered.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-base-content/60">No data</div>
  }

  // Merge timestamps across all selected users so missing buckets become 0
  // rather than misaligning lines on the X axis.
  const timestampSet = new Set<string>()
  for (const s of filtered) {
    for (const p of s.points) timestampSet.add(p.t)
  }
  const timestamps = Array.from(timestampSet).sort()
  const labels = timestamps.map((t) => formatBucketTime(t))

  const datasets = filtered.map((s, i) => {
    const c = TREND_PALETTE[i % TREND_PALETTE.length]
    const lookup = new Map(s.points.map((p) => [p.t, p.n]))
    return {
      label: s.name || '(empty)',
      data: timestamps.map((t) => lookup.get(t) ?? 0),
      borderColor: c,
      tension: 0.3,
      pointStyle: 'circle',
      pointRadius: 5,
      pointHoverRadius: 15,
    }
  })

  return (
    <div className="h-72">
      <Line
        data={{ labels, datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: indexInteraction,
          plugins: {
            legend: { position: 'bottom' as const },
            tooltip: indexTooltip,
          },
          scales: {
            x: { ticks: { maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true },
          },
        }}
      />
    </div>
  )
}

function HistogramChart({ data }: { data: TelemetryDurationsData }) {
  const labels = data.buckets.map((b) => formatBucketLabel(b.le))
  const chartData = {
    labels,
    datasets: [
      {
        label: data.metric === 'duration_seconds' ? 'Creates' : 'Deletes',
        data: data.buckets.map((b) => b.n),
        backgroundColor: data.metric === 'duration_seconds' ? '#3b82f6' : '#f97316',
      },
    ],
  }
  const fmt = formatDuration
  return (
    <div className="h-64">
      <Bar
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          interaction: indexInteraction,
          plugins: {
            legend: { display: false },
            tooltip: indexTooltip,
            title: {
              display: true,
              text: `P50 ${fmt(data.p50)} · P90 ${fmt(data.p90)} · P99 ${fmt(data.p99)}`,
              font: { size: 11, weight: 'normal' as const },
            },
          },
          scales: { y: { beginAtZero: true } },
        }}
      />
    </div>
  )
}

function lineOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: indexInteraction,
    plugins: {
      legend: { display: false },
      tooltip: indexTooltip,
    },
    scales: {
      x: { ticks: { maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true },
    },
  }
}

// Shared tooltip config: hovering anywhere on a bucket shows every series'
// value at that X position, not just the dataset under the cursor.
const indexInteraction = { mode: 'index' as const, intersect: false }
const indexTooltip = { mode: 'index' as const, intersect: false }

// --- Setup wizard ------------------------------------------------------------

type SetupWizardProps = {
  status: TelemetryStatusData | null
  envBlock: string
  onRefresh: () => void
}

function SetupWizard({ status, envBlock, onRefresh }: SetupWizardProps) {
  const installCmd = `kubectl apply -f ${status?.install_yaml_path ?? 'install/victorialogs.yaml'}`
  return (
    <>
      <MetricsHeader description="Telemetry is not enabled. Finish the steps below to start collecting sandbox lifecycle data." />

      <div className="mt-4 space-y-4">
      <SetupStep title="Step 1: Install VictoriaLogs" body={installCmd}>
        <p className="text-sm text-base-content/70">
          A single-instance VictoriaLogs StatefulSet (one pod, 10Gi PVC, 30-day retention). Apply it to the same
          namespace as agent-sandbox.
        </p>
      </SetupStep>

      <SetupStep title="Step 2: Set telemetry env vars on agent-sandbox" body={envBlock}>
        <p className="text-sm text-base-content/70">
          Add these to the agent-sandbox Deployment and roll the pods. The defaults already point at the in-cluster
          VictoriaLogs Service.
        </p>
      </SetupStep>

      <div className="card bg-base-100 shadow-sm">
        <div className="card-body p-4">
          <div className="mb-2 text-sm font-medium">Step 3: Verify</div>
          <p className="text-sm text-base-content/70">After restarting, click below to re-check.</p>
          <div className="mt-2">
            <button className="btn btn-sm btn-primary" onClick={onRefresh}>
              Check again
            </button>
          </div>
        </div>
      </div>
      </div>
    </>
  )
}

function SetupStep({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="card bg-base-100 shadow-sm">
      <div className="card-body p-4">
        <div className="mb-2 text-sm font-medium">{title}</div>
        {children}
        <div className="relative mt-3">
          <pre className="overflow-x-auto rounded bg-base-200 p-3 text-xs">{body}</pre>
          <button
            className="btn btn-xs absolute right-2 top-2"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(body)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              } catch {
                // ignore
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

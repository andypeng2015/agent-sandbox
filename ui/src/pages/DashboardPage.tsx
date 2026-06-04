import { ChangeEvent, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getRuntimeConfigStatus } from '../lib/api/config'
import { listSandboxEvents } from '../lib/api/events'
import { getRateLimitStatus, type NormalizedRateLimitStatusData } from '../lib/api/ratelimit'
import { listSandboxes } from '../lib/api/sandbox'
import type { RateLimitUserStatus, RuntimeConfigStatus, Sandbox, SandboxEventItem } from '../lib/api/types'
import { getAuthToken } from '../lib/auth/token'

const refreshIntervalOptions = [2000, 5000, 10000, 30000]
const limitOptions = [50, 100, 200, 500]

const emptyRateLimitStatus: NormalizedRateLimitStatusData = {
  default_config: {
    enabled: false,
    max_concurrency: 0,
    max_sandbox: 0,
  },
  users: [],
}

type LoadError = {
  section: string
  message: string
}

type DistributionItem = {
  name: string
  count: number
  percent: number
}

const topItemLimit = 5
const templateColorClasses = ['text-primary', 'text-secondary', 'text-accent', 'text-info', 'text-success']
const progressColorClasses = ['progress-primary', 'progress-secondary', 'progress-accent', 'progress-info', 'progress-success', 'progress-warning']

function clampPercent(value: number): number {
  return Math.max(0, Math.min(value, 100))
}

function templateColorClass(index: number): string {
  return templateColorClasses[index % templateColorClasses.length]
}

function progressColorClass(index: number): string {
  return progressColorClasses[index % progressColorClasses.length]
}

function formatKeyDisplay(value?: string): string {
  const key = value?.trim()
  if (!key) {
    return 'Unknown Key'
  }

  const parts = key.split('-').filter(Boolean)
  return `${parts.length >= 2 ? parts.slice(0, 2).join('-') : parts[0]}...`
}

function buildDistribution(items: string[], fallback: string): DistributionItem[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const name = item.trim() || fallback
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const total = items.length
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count, percent: total > 0 ? Math.round((count * 100) / total) : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function buildKeyDistribution(users: RateLimitUserStatus[]): DistributionItem[] {
  const total = users.reduce((sum, user) => sum + user.sandbox_current, 0)
  return users
    .map((user) => ({
      name: formatKeyDisplay(user.user),
      count: user.sandbox_current,
      percent: total > 0 ? Math.round((user.sandbox_current * 100) / total) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function formatLimit(value: number): string {
  return value > 0 ? String(value) : 'Unlimited'
}

function formatEventTime(item: SandboxEventItem): string {
  const candidates = [item.eventTime, item.lastTimestamp, item.firstTimestamp]
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate)
    if (Number.isNaN(parsed)) {
      continue
    }

    const date = new Date(parsed)
    if (date.getUTCFullYear() <= 1) {
      continue
    }

    return date.toLocaleString()
  }
  return '-'
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export default function DashboardPage() {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [rateLimitStatus, setRateLimitStatus] = useState<NormalizedRateLimitStatusData>(emptyRateLimitStatus)
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigStatus | null>(null)
  const [events, setEvents] = useState<SandboxEventItem[]>([])
  const [loadErrors, setLoadErrors] = useState<LoadError[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAutoRefresh, setIsAutoRefresh] = useState(true)
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(5000)
  const [eventLimit, setEventLimit] = useState(100)
  const requestInFlightRef = useRef(false)

  const isSystemToken = getAuthToken().startsWith('sys-')

  const loadDashboard = useCallback(async () => {
    if (requestInFlightRef.current) {
      return
    }

    requestInFlightRef.current = true
    setIsLoading(true)
    setLoadErrors([])

    try {
      const [sandboxResult, rateLimitResult, eventsResult, runtimeResult] = await Promise.allSettled([
        listSandboxes(),
        getRateLimitStatus(),
        listSandboxEvents({ limit: eventLimit }),
        isSystemToken ? getRuntimeConfigStatus() : Promise.resolve(null),
      ])
      const nextErrors: LoadError[] = []

      if (sandboxResult.status === 'fulfilled') {
        setSandboxes(sandboxResult.value)
      } else {
        nextErrors.push({ section: 'Sandboxes', message: formatError(sandboxResult.reason, 'Failed to load sandboxes') })
        setSandboxes([])
      }

      if (rateLimitResult.status === 'fulfilled') {
        setRateLimitStatus(rateLimitResult.value)
      } else {
        nextErrors.push({ section: 'Capacity', message: formatError(rateLimitResult.reason, 'Failed to load capacity') })
        setRateLimitStatus(emptyRateLimitStatus)
      }

      if (eventsResult.status === 'fulfilled') {
        setEvents(Array.isArray(eventsResult.value.items) ? eventsResult.value.items : [])
      } else {
        nextErrors.push({ section: 'Events', message: formatError(eventsResult.reason, 'Failed to load events') })
        setEvents([])
      }

      if (runtimeResult.status === 'fulfilled') {
        setRuntimeConfig(runtimeResult.value)
      } else {
        nextErrors.push({ section: 'Runtime Config', message: formatError(runtimeResult.reason, 'Failed to load runtime config') })
        setRuntimeConfig(null)
      }

      setLoadErrors(nextErrors)
    } finally {
      requestInFlightRef.current = false
      setIsLoading(false)
    }
  }, [eventLimit, isSystemToken])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    if (!isAutoRefresh) {
      return
    }

    const timer = window.setInterval(() => {
      void loadDashboard()
    }, refreshIntervalMs)

    return () => {
      window.clearInterval(timer)
    }
  }, [isAutoRefresh, loadDashboard, refreshIntervalMs])

  const handleRefreshIntervalChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const parsed = Number.parseInt(event.target.value, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      setRefreshIntervalMs(parsed)
    }
  }

  const handleEventLimitChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const parsed = Number.parseInt(event.target.value, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      setEventLimit(parsed)
    }
  }

  const runningSandboxes = useMemo(
    () => sandboxes.filter((sandbox) => sandbox.status?.toLowerCase() === 'running').length,
    [sandboxes],
  )
  const otherSandboxes = Math.max(0, sandboxes.length - runningSandboxes)
  const keyDistribution = useMemo(() => buildKeyDistribution(rateLimitStatus.users), [rateLimitStatus.users])
  const templateDistribution = useMemo(
    () => buildDistribution(sandboxes.map((sandbox) => sandbox.template || ''), 'Custom'),
    [sandboxes],
  )
  const totalConfiguredKeys = runtimeConfig?.api_tokens_count ?? keyDistribution.length

  return (
    <>
      <header className="card border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Dashboard</h2>
            <p className="text-sm text-base-content/70">Monitor sandbox inventory, capacity, API keys, templates, and recent events.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
              <label className="label cursor-pointer gap-2 py-0">
                <span className="label-text text-sm">Auto Refresh</span>
                <input
                  className="toggle toggle-sm"
                  type="checkbox"
                  checked={isAutoRefresh}
                  onChange={() => {
                    setIsAutoRefresh((prev) => !prev)
                  }}
                />
              </label>
              <select className="select select-sm select-bordered w-20" value={refreshIntervalMs} onChange={handleRefreshIntervalChange}>
                {refreshIntervalOptions.map((option) => (
                  <option key={option} value={option}>
                    {option / 1000}s
                  </option>
                ))}
              </select>
              <select className="select select-sm select-bordered w-28" value={eventLimit} onChange={handleEventLimitChange}>
                {limitOptions.map((option) => (
                  <option key={option} value={option}>
                    {option} events
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => void loadDashboard()} disabled={isLoading}>
                {isLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
        </div>
      </header>

      {loadErrors.length > 0 && (
        <section>
          <div className="alert alert-error">
            <div>
              <div className="font-semibold">Some dashboard data could not be loaded.</div>
              <ul className="list-disc pl-5 text-sm">
                {loadErrors.map((error) => (
                  <li key={error.section}>
                    {error.section}: {error.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      <section className="grid gap-3 xl:grid-cols-12">
        <div className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-3">
          <div className="card-body gap-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="card-title text-lg">Sandboxes</h3>
              <div className="badge badge-outline">{sandboxes.length} total</div>
            </div>
            <div className="flex items-center gap-4">
              <div className="radial-progress" style={{"--size": "8rem", "--thickness": "2px", '--value': sandboxes.length > 0 ? Math.round((runningSandboxes * 100) / sandboxes.length) : 0 } as CSSProperties}>
                {sandboxes.length > 0 ? Math.round((runningSandboxes * 100) / sandboxes.length) : 0}%
              </div>
              <div className="space-y-1 text-sm">
                  <div className="font-medium">Running: <span className="text-lg  badge badge-neutral">{runningSandboxes}</span></div>
                <div className="text-base-content/70">Other: {otherSandboxes}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-9">
          <div className="card-body gap-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="card-title text-lg">Templates <span className="text-sm font-thin">(TOP-5)</span></h3>
              <div className="badge badge-secondary badge-outline">{templateDistribution.length} templates</div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
              {templateDistribution.length === 0 ? (
                <div className="text-sm text-base-content/60">No template usage found.</div>
              ) : (
                templateDistribution.slice(0, topItemLimit).map((item, index) => (
                  <div key={item.name} className="rounded-box h-full border border-base-300 p-4">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div
                        className={`radial-progress border-4 ${templateColorClass(index)}`}
                        style={{ '--value': item.percent, '--size': index === 0 ? '6rem' : '5rem', '--thickness': '0.65rem' } as CSSProperties}
                      >
                        {item.percent}%
                      </div>
                      <div className="w-full min-w-0">
                        <div className="tooltip tooltip-bottom max-w-full" data-tip={item.name}>
                          <div className="truncate font-medium">{item.name}</div>
                        </div>
                        <div className="text-sm text-base-content/70">{item.count} sandboxes</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-5">
          <div className="card-body gap-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="card-title text-lg">API Keys <span className="text-sm font-thin">(TOP-5)</span></h3>
              <div className="badge badge-primary badge-outline">{totalConfiguredKeys} keys</div>
            </div>
            <div className="space-y-3">
              {keyDistribution.length === 0 ? (
                <div className="text-sm text-base-content/60">No API key sandbox usage found.</div>
              ) : (
                keyDistribution.slice(0, topItemLimit).map((item, index) => (
                  <div key={item.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-medium">{item.name}</span>
                      <span className="tabular-nums text-base-content/70">{item.count} / {sandboxes.length} sandboxes · {item.percent}%</span>
                    </div>
                    <progress className={`progress ${progressColorClass(index)} h-2 w-full`} value={item.percent} max="100" />
                  </div>
                ))
              )}
              {!isSystemToken && <div className="text-xs text-base-content/60">System token required to show configured key count.</div>}
            </div>
          </div>
        </div>

        <div className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-7">
          <div className="card-body gap-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="card-title text-lg">Capacity <span className="text-sm font-thin">(TOP-5)</span></h3>
                <div className="badge badge-secondary badge-outline">
                  {rateLimitStatus.default_config.enabled ? 'Enabled' : 'Disabled'}
                </div>
                <div className="badge badge-outline">Default Sandbox: {formatLimit(rateLimitStatus.default_config.max_sandbox)}</div>
                <div className="badge badge-outline">Default Concurrency: {formatLimit(rateLimitStatus.default_config.max_concurrency)}</div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rateLimitStatus.users.length === 0 ? (
                <div className="text-sm text-base-content/60">No per-key capacity data found.</div>
              ) : (
                rateLimitStatus.users.slice(0, topItemLimit).map((user, index) => {
                  const usagePercent = user.sandbox_max > 0 ? clampPercent(user.sandbox_usage_percent) : 0
                  return (
                    <div key={user.user || `capacity-${index}`} className="rounded-box border border-base-300 p-3">
                      <div className="mb-2 text-sm">
                        <span className="truncate font-medium">{formatKeyDisplay(user.user)}</span>
                      </div>
                      <progress className={`progress ${progressColorClass(index)} h-2 w-full`} value={usagePercent} max="100" />
                      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-base-content/70">
                        <span className="tabular-nums">{user.sandbox_current} / {formatLimit(user.sandbox_max)}</span>
                        <span className="tabular-nums">{user.sandbox_max > 0 ? `${usagePercent}%` : '-'}</span>
                      </div>
                      <div className="mt-2 text-xs text-base-content/60">Concurrency: {user.concurrency_active} / {formatLimit(user.concurrency_max)}</div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="card-title text-lg">Recent Events</h3>
              <div className="badge badge-outline">{events.length} events</div>
            </div>

            <div className="h-[calc(100vh-28rem)] min-h-72 overflow-auto rounded-box border border-base-300">
              <table className="table table-pin-rows table-zebra">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Reason</th>
                    <th>Sandbox</th>
                    <th>Message</th>
                    <th className="text-right">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-base-content/60">
                        No events found.
                      </td>
                    </tr>
                  )}
                  {events.map((event) => {
                    const eventType = event.type || '-'
                    const badgeClass = eventType.toLowerCase() === 'warning' ? 'badge-warning' : 'badge-info'

                    return (
                      <tr key={event.name}>
                        <td className="whitespace-nowrap text-xs">{formatEventTime(event)}</td>
                        <td>
                          <span className={`badge badge-sm ${badgeClass}`}>{eventType}</span>
                        </td>
                        <td className="font-medium">{event.reason || '-'}</td>
                        <td>{event.involvedObject?.name || '-'}</td>
                        <td className="max-w-xl whitespace-normal text-sm text-base-content/80">{event.message || '-'}</td>
                        <td className="text-right tabular-nums">{event.count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

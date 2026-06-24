import { useEffect, useState } from 'react'

import { TELEMETRY_TIME_RANGES, type TelemetryTimeRange } from '../../lib/api/telemetry'

// `datetime-local` inputs use the format YYYY-MM-DDTHH:mm in the user's local
// timezone (no zone suffix). Converting to/from ISO 8601 lets us keep URL state
// in UTC while presenting local time in the form.
function isoToLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localToISO(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export type TelemetryRangeControlsProps = {
  // Active preset, used to highlight a chip when no custom range is set.
  since: TelemetryTimeRange
  // Active custom range in ISO 8601 UTC. Empty string = no custom range.
  startISO: string
  endISO: string
  onSelectPreset: (since: TelemetryTimeRange) => void
  onApplyCustom: (startISO: string, endISO: string) => void
  onClearCustom: () => void
}

export default function TelemetryRangeControls({
  since,
  startISO,
  endISO,
  onSelectPreset,
  onApplyCustom,
  onClearCustom,
}: TelemetryRangeControlsProps) {
  // Local form state so typing in the inputs doesn't fire a request per keystroke.
  const [startInput, setStartInput] = useState(isoToLocal(startISO))
  const [endInput, setEndInput] = useState(isoToLocal(endISO))
  const [formError, setFormError] = useState('')

  // Reseed inputs when the URL-driven props change (e.g. browser back/forward).
  useEffect(() => setStartInput(isoToLocal(startISO)), [startISO])
  useEffect(() => setEndInput(isoToLocal(endISO)), [endISO])

  const hasCustomRange = Boolean(startISO && endISO)

  const apply = () => {
    setFormError('')
    const start = localToISO(startInput)
    const end = localToISO(endInput)
    if (!start || !end) {
      setFormError('Pick both start and end.')
      return
    }
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      setFormError('End must be after start.')
      return
    }
    onApplyCustom(start, end)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">Time:</span>
      <div className="join">
        {TELEMETRY_TIME_RANGES.map((r) => (
          <button
            key={r}
            className={`join-item btn btn-sm ${!hasCustomRange && since === r ? 'btn-primary' : ''}`}
            onClick={() => onSelectPreset(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <span className="text-sm">From:</span>
      <input
        type="datetime-local"
        className="input input-sm input-bordered w-40"
        value={startInput}
        onChange={(e) => setStartInput(e.target.value)}
      />
      <span className="text-sm">To:</span>
      <input
        type="datetime-local"
        className="input input-sm input-bordered  w-40"
        value={endInput}
        onChange={(e) => setEndInput(e.target.value)}
      />
      <button className="btn btn-sm" onClick={apply}>
        Apply
      </button>
      {hasCustomRange && (
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setStartInput('')
            setEndInput('')
            setFormError('')
            onClearCustom()
          }}
        >
          Clear
        </button>
      )}
      {formError && <span className="text-xs text-error">{formError}</span>}
    </div>
  )
}

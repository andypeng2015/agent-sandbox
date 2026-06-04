# Sandbox Pause / Resume

## Background

Agent-Sandbox can pause a sandbox instead of deleting it when timeout or idle-timeout cleanup runs. A paused sandbox keeps the same logical sandbox ID, name, labels, and ReplicaSet, but scales the ReplicaSet to zero replicas so the Pod is removed and compute resources are released.

Resume scales the same ReplicaSet back to one replica, waits for the Pod to become ready, and replays envd-managed processes captured before pause.

This is not process checkpoint/restore. It does not preserve memory, PID values, open sockets, PTYs, shell sessions, or in-flight requests. It restores best-effort long-running processes by asking envd for its process list before pause and calling envd's process start API after resume.

## Current implementation summary

Relevant files:

| Area | File | Behavior |
| --- | --- | --- |
| State and annotations | `pkg/sandbox/sandbox.go` | Defines `Paused`, `Running`, `Creating` and pause/resume annotations. |
| Status derivation | `pkg/sandbox/controller.go` | `GetSandbox` and `DoList` derive status from ReplicaSet state and annotations. |
| Pause/resume controller | `pkg/sandbox/pause_resume.go` | Scales ReplicaSet to zero/one and records pause/resume metadata. |
| Process snapshot | `pkg/sandbox/process_snapshot.go` | Captures envd process list and restores processes through envd. |
| Timeout cleanup | `pkg/scaler/timeout_scaler.go` | Pauses on timeout when `Sandbox.AutoPause` and `config.Cfg.PauseResume` are true; otherwise deletes. |
| Idle cleanup | `pkg/scaler/idle_scaler.go` | Pauses on idle timeout when `Sandbox.AutoPause` and `config.Cfg.PauseResume` are true; otherwise deletes. |
| E2B create/connect/proxy | `pkg/api/e2b/sandbox.go` | Maps `autoPause`/`autoResume`; connect and proxy routes can resume paused sandboxes. |
| Native test APIs | `pkg/handler/handler.go`, `pkg/handler/handlers.go` | Registers native pause/resume endpoints for manual testing. |

## Sandbox state model

Current sandbox states:

```go
const (
    Paused   SandboxState = "paused"
    Running  SandboxState = "running"
    Creating SandboxState = "creating"
)
```

Status is derived from the ReplicaSet instead of being written back into `sandbox-data`:

| ReplicaSet state | Reported status |
| --- | --- |
| `agent-sandbox.github.io/paused == "true"` and desired replicas is `0` | `paused` |
| desired replicas is greater than `0` and equals ready replicas | `running` |
| otherwise | `creating` |

`sandbox-data` is not updated during pause/resume. The ReplicaSet annotations and replica count are the source of truth for paused state.

## Annotation contract

Current annotations:

| Annotation | Meaning |
| --- | --- |
| `sandbox-data` | Existing serialized sandbox data. Not rewritten for pause/resume status. |
| `agent-sandbox.github.io/paused` | Set to `true` while the sandbox is paused. Removed on resume. |
| `agent-sandbox.github.io/paused-at` | UTC RFC3339 timestamp for the pause operation. Removed on resume. |
| `agent-sandbox.github.io/pause-reason` | Reason passed to `Controller.Pause`, such as `timeout`, `idleTimeout`, or `api`. Removed on resume. |
| `agent-sandbox.github.io/resumed-at` | UTC RFC3339 timestamp for the last resume. Used by timeout cleanup as the new timeout base. |
| `agent-sandbox.github.io/resume-reason` | Reason passed to `Controller.Resume`, such as `SDKGetSandbox`, `RequestOfPath`, `Request`, or `api`. |
| `agent-sandbox.github.io/process-snapshot` | Base64-encoded JSON snapshot of envd-managed processes. |

There are no current `pause-error` or `resume-error` annotations.

## Feature gates and create-time switches

Pause cleanup requires both:

1. The sandbox has `Sandbox.AutoPause == true`.
2. Global config `config.Cfg.PauseResume == true`.

E2B creation maps request fields into the internal sandbox:

| E2B field | Internal field | Effect |
| --- | --- | --- |
| `NewSandbox.AutoPause` | `Sandbox.AutoPause` | Timeout and idle-timeout cleanup pause instead of delete when enabled with `PauseResume`. |
| `NewSandbox.AutoResume.Enabled` | `Sandbox.AutoResume` | E2B connect/proxy paths resume paused sandboxes before forwarding when enabled. |

If `AutoPause` is false or `PauseResume` is disabled, timeout and idle-timeout cleanup keep the existing delete behavior.

## Pause flow

`Controller.Pause(sb, reason)` currently:

1. Returns immediately if the sandbox already derives as `paused`.
2. Calls `captureProcessSnapshot(sb)`.
3. Deep-copies `sb.ReplicaSet`.
4. Ensures the annotation map exists.
5. Sets:
   - `agent-sandbox.github.io/paused=true`
   - `agent-sandbox.github.io/paused-at=<now UTC RFC3339>`
   - `agent-sandbox.github.io/pause-reason=<reason>`
   - `agent-sandbox.github.io/process-snapshot=<base64 snapshot>`
6. Sets `spec.replicas=0`.
7. Updates the ReplicaSet through the Kubernetes client.

Pause uses the ReplicaSet already attached to the `Sandbox` object. It does not perform an extra API-server GET in the pause path.

If snapshot capture fails, pause fails and the ReplicaSet is not scaled to zero.

## Timeout and idle-timeout cleanup

Timeout cleanup:

- Lists all sandboxes.
- Uses `agent-sandbox.github.io/resumed-at` as the timeout base when present and valid.
- Falls back to `Sandbox.CreatedAt` when there is no valid `resumed-at`.
- Skips very recent sandboxes using `ScalingCheckInterval`.
- If expired:
  - pauses when `sb.AutoPause && config.Cfg.PauseResume` is true;
  - otherwise deletes.

Idle-timeout cleanup:

- Lists all sandboxes.
- Skips paused sandboxes.
- Skips very recent sandboxes using `ScalingCheckInterval`.
- Uses activator last-request time to calculate idleness.
- If idle timeout is exceeded:
  - pauses when `sb.AutoPause && config.Cfg.PauseResume` is true;
  - otherwise deletes.

Both cleanup paths record Kubernetes events for pause/delete success or failure.

## Resume flow

`Controller.Resume(sb, reason)` currently:

1. Returns immediately if the sandbox does not derive as `paused`.
2. Logs the resume reason.
3. Reads the snapshot from `agent-sandbox.github.io/process-snapshot`.
4. Deep-copies `sb.ReplicaSet`.
5. Removes pause annotations:
   - `agent-sandbox.github.io/paused`
   - `agent-sandbox.github.io/paused-at`
   - `agent-sandbox.github.io/pause-reason`
6. Sets resume annotations:
   - `agent-sandbox.github.io/resumed-at=<now UTC RFC3339>`
   - `agent-sandbox.github.io/resume-reason=<reason>`
7. Sets `spec.replicas=1`.
8. Updates the ReplicaSet through the Kubernetes client.
9. Waits for the ReplicaSet to become ready with `WaitForReplicaSetReady`.
10. Calls `restoreProcessSnapshot(sb, snapshot)`.

Resume is synchronous. If the ReplicaSet does not become ready or process restore fails, the resume call returns an error after the ReplicaSet has already been scaled to one.

## Resume triggers

Current resume triggers:

| Trigger | Condition | Reason |
| --- | --- | --- |
| E2B connect | Sandbox is paused and `Sandbox.AutoResume == true` | `SDKGetSandbox` |
| Path router `/sandboxes/router/{sandboxID}/{port}/...` | Sandbox is paused and `Sandbox.AutoResume == true` | `RequestOfPath` |
| Domain router `{port}-{sandboxID}.{domain}` | Sandbox is paused and `Sandbox.AutoResume == true` | `Request` |
| Native API | Manual resume endpoint is called | `api` |

If `Sandbox.AutoResume` is false, E2B connect/proxy paths do not resume automatically.

## Native pause/resume APIs

Native APIs currently exist for manual testing:

```text
POST {APIBaseURL}/sandbox/pause/{name}
POST {APIBaseURL}/sandbox/resume/{name}
```

These are native management APIs, not E2B APIs. The E2B API does not expose explicit pause/resume routes in the current implementation.

## Process snapshot format

Snapshot capture calls envd's process list endpoint on the sandbox envd port (`49983`):

```text
POST /process.Process/List
Content-Type: application/json
Connect-Protocol-Version: 1
X-Access-Token: <sandbox ID>
```

The response is decoded into `e2bapi.ListResponse`:

```go
type ListResponse struct {
    Processes []ProcessInfo `json:"processes"`
}

type ProcessInfo struct {
    Config ProcessConfig `json:"config"`
    PID    int           `json:"pid"`
    Tag    string        `json:"tag,omitempty"`
}

type ProcessConfig struct {
    Cmd  string            `json:"cmd,omitempty"`
    Args []string          `json:"args,omitempty"`
    Envs map[string]string `json:"envs,omitempty"`
    Cwd  string            `json:"cwd,omitempty"`
}
```

The stored snapshot is Base64-encoded JSON:

```json
{
  "captured_time": "2026-05-22T07:31:39Z",
  "processes": [
    {
      "config": {
        "cmd": "/bin/bash",
        "args": ["-l", "-c", "python -m http.server 8001"]
      },
      "pid": 203
    }
  ]
}
```

The original PID is stored for diagnostics only. It is not reused on resume.

## Process restore

Restore decodes the snapshot, resolves the envd destination once, and starts each captured process through envd:

```text
POST /process.Process/Start
Content-Type: application/connect+json
Connect-Protocol-Version: 1
Authorization: Basic dXNlcjo=
X-Access-Token: <sandbox ID>
```

Request body uses the Connect unary envelope format:

```text
1 byte flags + 4 byte big-endian JSON length + JSON payload
```

The JSON payload is `e2bapi.StartRequest`:

```go
type StartRequest struct {
    Process ProcessConfig `json:"process"`
    Tag     string        `json:"tag,omitempty"`
    Stdin   bool          `json:"stdin,omitempty"`
}
```

The start request uses a short context timeout to avoid hanging forever while waiting for response headers. After receiving a response, restore reads only the first Connect message instead of reading the full response stream. This matters because envd start can return a streaming response and may keep the response body open.

A process is considered restored only when the first response message decodes to a `StartResponse` with a non-zero PID:

```json
{"event":{"start":{"pid":64}}}
```

Current response model:

```go
type StartResponse struct {
    Event StartResponseEvent `json:"event"`
}

type StartResponseEvent struct {
    Start ProcessInfo `json:"start"`
}
```

## Current limitations

- No CRIU or OS-level process checkpointing.
- Process memory, sockets, open files, PTYs, shell sessions, and in-flight requests are not preserved.
- Snapshot capture depends on envd's process list API.
- Restore depends on envd's process start API and Connect envelope behavior.
- There is no process whitelist in the current implementation; captured envd processes are replayed as returned by envd.
- Pause and resume update ReplicaSets directly and do not currently use conflict retry helpers.
- There is no per-sandbox operation lock for concurrent pause/resume/delete races.
- There is no snapshot size limit yet.
- There are no pause-error or resume-error annotations yet.
- If restore fails after the ReplicaSet has scaled up, the sandbox may be running but process replay may be incomplete.
- Filesystem state must survive Pod recreation for replayed processes to work correctly.

## Filesystem assumptions

Command replay only works when files needed by the command still exist after the Pod is recreated. This requires one of:

- persistent workspace volume;
- CSI-backed sandbox filesystem;
- shared PVC or object-backed mount;
- template image containing the required files.

If the sandbox filesystem is ephemeral and deleted with the Pod, resume can only restart processes that do not depend on runtime-generated files.

## Security considerations

- Snapshot data can include command arguments and selected envd process config. Treat it as sensitive.
- Do not log full snapshots at info level.
- Keep the snapshot in ReplicaSet annotations only if its size remains small enough for Kubernetes object limits.
- Restore does not shell-quote or reconstruct arbitrary command strings itself; it sends the structured envd process config back to envd.
- E2B connect/proxy and native management APIs continue to rely on existing auth middleware.

## Suggested hardening

- Add a max snapshot size before writing the ReplicaSet annotation.
- Add conflict retries around ReplicaSet updates.
- Add a per-sandbox operation lock or distributed coordination for pause/resume/delete.
- Add `pause-error` and `resume-error` annotations for failed operations.
- Add unit tests for status derivation, snapshot encode/decode, Connect envelope encoding/decoding, and timeout base selection after resume.
- Add integration tests for timeout pause, idle-timeout pause, E2B connect resume, proxy-triggered resume, and process replay.
- Consider recording `resumed=true` in E2B metadata consistently if clients need to distinguish a connect response that triggered resume.
- Consider pruning stale snapshots after successful resume if repeated replay becomes a risk.

## Manual verification checklist

1. Create an E2B sandbox with `autoPause: true` and `autoResume.enabled: true`.
2. Start a long-running process through envd, for example `python -m http.server`.
3. Trigger timeout or idle-timeout pause.
4. Verify the ReplicaSet still exists with `spec.replicas=0`.
5. Verify annotations include:
   - `agent-sandbox.github.io/paused=true`
   - `agent-sandbox.github.io/paused-at=<timestamp>`
   - `agent-sandbox.github.io/pause-reason=<reason>`
   - `agent-sandbox.github.io/process-snapshot=<base64>`
6. Verify E2B get/list reports state `paused`.
7. Trigger resume via E2B connect, proxy request, or native resume API.
8. Verify the same ReplicaSet has `spec.replicas=1` and becomes ready.
9. Verify annotations include:
   - `agent-sandbox.github.io/resumed-at=<timestamp>`
   - `agent-sandbox.github.io/resume-reason=<reason>`
10. Verify the process has been restarted through envd and receives a new PID.
11. Verify timeout cleanup uses `resumed-at` as the timeout base so the sandbox is not immediately reclaimed after resume.

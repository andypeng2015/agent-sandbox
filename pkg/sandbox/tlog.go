/*
 * Copyright 2025 The https://github.com/agent-sandbox/agent-sandbox Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package sandbox

import (
	"github.com/agent-sandbox/agent-sandbox/pkg/telemetry"
)

func TLog(sbx *Sandbox, tlog telemetry.TLog) {
	base := buildSbxInfo(sbx)
	if tlog.Sbx.UserKey == "" {
		tlog.Sbx.UserKey = base.UserKey
	}
	if tlog.Sbx.SandboxID == "" {
		tlog.Sbx.SandboxID = base.SandboxID
	}
	if tlog.Sbx.SandboxName == "" {
		tlog.Sbx.SandboxName = base.SandboxName
	}
	if tlog.Sbx.Template == "" {
		tlog.Sbx.Template = base.Template
	}
	if tlog.Sbx.App == "" {
		tlog.Sbx.App = base.App
	}
	if tlog.Sbx.CreatedAt.IsZero() {
		tlog.Sbx.CreatedAt = base.CreatedAt
	}
	tlog.Sbx.AutoPause = base.AutoPause
	tlog.Sbx.FromPool = base.FromPool

	telemetry.EmitTLog(tlog)
}

func buildSbxInfo(sb *Sandbox) telemetry.SbxInfo {
	if sb == nil {
		return telemetry.SbxInfo{}
	}
	info := telemetry.SbxInfo{
		SandboxID:   sb.ID,
		SandboxName: sb.Name,
		Template:    sb.Template,
		App:         sb.App,
		AutoPause:   sb.AutoPause,
		CreatedAt:   sb.CreatedAt,
		UserKey:     sb.User,
		FromPool:    sb.IsPool,
	}
	if info.UserKey == "" && sb.ReplicaSet != nil {
		info.UserKey = sb.ReplicaSet.Labels[UserLabel]
	}
	if sb.ReplicaSet != nil && sb.ReplicaSet.Labels[PoolLabel] != "" {
		info.FromPool = sb.ReplicaSet.Labels[PoolLabel] == "true"
	}
	return info
}

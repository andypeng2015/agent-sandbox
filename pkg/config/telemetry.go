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

package config

// TelemetryConfig controls lifecycle-event telemetry (sandbox.create / sandbox.delete).
//
// Defaults target an in-cluster single-instance VictoriaLogs Service named
// "victorialogs" on port 9428 (see install/victorialogs.yaml). To send to a
// different OTLP backend, override OTLPEndpoint / OTLPURLPath / OTLPInsecure.
type TelemetryConfig struct {
	Enabled      bool    `split_words:"true" default:"false" json:"enabled"`
	OTLPEndpoint string  `split_words:"true" default:"victorialogs:9428" json:"otlp_endpoint"`
	OTLPURLPath  string  `split_words:"true" default:"/insert/opentelemetry/v1/logs" json:"otlp_url_path"`
	OTLPInsecure bool    `split_words:"true" default:"true" json:"otlp_insecure"`
	BufferSize   int     `split_words:"true" default:"1024" json:"buffer_size"`
	SampleRate   float64 `split_words:"true" default:"1.0" json:"sample_rate"`
}

// QueryEndpoint returns the dashboard query URL derived from OTLPEndpoint.
// In-cluster VictoriaLogs is plain HTTP; operators terminating TLS in front
// of it are expected to configure a custom backend (out of scope for v1).
func (c TelemetryConfig) QueryEndpoint() string {
	if c.OTLPEndpoint == "" {
		return ""
	}
	return "http://" + c.OTLPEndpoint
}

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

package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// QueryClient is a thin wrapper around VictoriaLogs' LogsQL HTTP API.
type QueryClient struct {
	endpoint string
	client   *http.Client
}

// NewQueryClient builds a client pointed at a VictoriaLogs HTTP endpoint
// (e.g. "http://victorialogs:9428").
func NewQueryClient(endpoint string) *QueryClient {
	return &QueryClient{
		endpoint: strings.TrimRight(endpoint, "/"),
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

// EscapeLogsQL escapes a user-supplied string for inclusion inside a
// double-quoted LogsQL token. We deliberately keep this strict: anything
// non-printable or quote-like is dropped rather than escaped, since the
// underlying user_key values are never expected to contain such characters.
func EscapeLogsQL(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r < 0x20, r == '"', r == '\\', r == '`':
			// drop
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// promResult is the shape both stats_query and stats_query_range return.
type promResult struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  []any             `json:"value,omitempty"`
			Values [][]any           `json:"values,omitempty"`
		} `json:"result"`
	} `json:"data"`
	Error     string `json:"error,omitempty"`
	ErrorType string `json:"errorType,omitempty"`
}

// ScalarResult is a single number returned by stats_query.
type ScalarResult struct {
	Labels map[string]string
	Value  float64
}

// SeriesResult is one labeled time series returned by stats_query_range.
type SeriesResult struct {
	Labels map[string]string
	Points []SeriesPoint
}

// SeriesPoint is a (timestamp, value) sample.
type SeriesPoint struct {
	T time.Time
	V float64
}

// StatsQuery executes a single-point LogsQL stats query.
func (q *QueryClient) StatsQuery(ctx context.Context, query string, at time.Time) ([]ScalarResult, error) {
	v := url.Values{}
	v.Set("query", query)
	if !at.IsZero() {
		v.Set("time", strconv.FormatInt(at.Unix(), 10))
	}

	body, err := q.do(ctx, "/select/logsql/stats_query", v)
	if err != nil {
		return nil, err
	}

	var raw promResult
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode stats_query response: %w", err)
	}
	if raw.Status != "" && raw.Status != "success" {
		return nil, fmt.Errorf("logsql error: %s %s", raw.ErrorType, raw.Error)
	}

	out := make([]ScalarResult, 0, len(raw.Data.Result))
	for _, r := range raw.Data.Result {
		if len(r.Value) != 2 {
			continue
		}
		v, ok := toFloat(r.Value[1])
		if !ok {
			continue
		}
		out = append(out, ScalarResult{Labels: r.Metric, Value: v})
	}
	return out, nil
}

// LogQuery executes a raw LogsQL query and returns each log record as a
// generic map. VictoriaLogs responds with newline-delimited JSON; we accumulate
// up to `limit` records.
func (q *QueryClient) LogQuery(ctx context.Context, query string, limit int) ([]map[string]any, error) {
	if limit <= 0 {
		limit = 100
	}
	v := url.Values{}
	v.Set("query", query)
	v.Set("limit", strconv.Itoa(limit))

	body, err := q.do(ctx, "/select/logsql/query", v)
	if err != nil {
		return nil, err
	}

	out := make([]map[string]any, 0, limit)
	for _, line := range bytes.Split(body, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal(line, &rec); err != nil {
			// Skip malformed lines rather than failing the whole query.
			continue
		}
		out = append(out, rec)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// StatsQueryRange executes a time-series LogsQL stats query.
func (q *QueryClient) StatsQueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) ([]SeriesResult, error) {
	v := url.Values{}
	v.Set("query", query)
	v.Set("start", strconv.FormatInt(start.Unix(), 10))
	v.Set("end", strconv.FormatInt(end.Unix(), 10))
	v.Set("step", fmt.Sprintf("%ds", int(step.Seconds())))

	body, err := q.do(ctx, "/select/logsql/stats_query_range", v)
	if err != nil {
		return nil, err
	}

	var raw promResult
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode stats_query_range response: %w", err)
	}
	if raw.Status != "" && raw.Status != "success" {
		return nil, fmt.Errorf("logsql error: %s %s", raw.ErrorType, raw.Error)
	}

	out := make([]SeriesResult, 0, len(raw.Data.Result))
	for _, r := range raw.Data.Result {
		points := make([]SeriesPoint, 0, len(r.Values))
		for _, p := range r.Values {
			if len(p) != 2 {
				continue
			}
			ts, ok := toFloat(p[0])
			if !ok {
				continue
			}
			val, ok := toFloat(p[1])
			if !ok {
				continue
			}
			points = append(points, SeriesPoint{
				T: time.Unix(int64(ts), 0).UTC(),
				V: val,
			})
		}
		out = append(out, SeriesResult{Labels: r.Metric, Points: points})
	}
	return out, nil
}

func (q *QueryClient) do(ctx context.Context, path string, params url.Values) ([]byte, error) {
	if q.endpoint == "" {
		return nil, fmt.Errorf("query endpoint not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, q.endpoint+path, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := q.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call %s: %w", path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("call %s: status %d: %s", path, resp.StatusCode, truncateBytes(body, 256))
	}
	return body, nil
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		f, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func truncateBytes(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}

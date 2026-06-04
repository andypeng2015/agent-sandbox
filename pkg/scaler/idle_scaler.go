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

package scaler

import (
	"fmt"
	"time"

	"github.com/agent-sandbox/agent-sandbox/pkg/config"
	"github.com/agent-sandbox/agent-sandbox/pkg/sandbox"
	v1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	v1meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/klog/v2"
)

// ScalingDownOfIdleTimeout checks sandboxes for idle timeout and deletes them if necessary
// TODO 1, record last active(e.g. in 2 minute) sandboxes and skip them reduce pressure on kube-apiserver;
// TODO 2, use lease to instead of event to record last request time, which is more efficient and can avoid pressure on kube-apiserver
func (s *Scaler) ScalingDownOfIdleTimeout() {
	sbs, err := s.controller.ListAll()
	if err != nil {
		klog.Error("Failed to list sandboxes for idle timeout scaling down: ", err)
		return
	}

	for _, sb := range sbs {
		// Skip if IdleTimeout is not configured (0 or negative)
		if sb.IdleTimeout <= 0 {
			continue
		}

		// Skip paused, and creating less than 5 minutes sandboxes
		if sb.Status == sandbox.Paused {
			continue
		}
		if time.Since(sb.CreatedAt) < ScalingCheckInterval {
			continue
		}

		// Calculate idle time
		now := time.Now().Unix()
		sbxIdleTimeout := int64(sb.IdleTimeout)

		// Skip if idleTimeout is not reached with created time,
		//since last-request-time be greater than created time
		if now-sb.CreatedAt.Unix() < sbxIdleTimeout {
			klog.V(2).Infof("Sandbox %v is not idle yet with createdAt: %v, idle: %v/%d",
				sb.Name, sb.CreatedAt, now-sb.CreatedAt.Unix(), sbxIdleTimeout)
			continue
		}

		// Get the last request time from events
		lastRequestTime := s.activator.GetLastRequestTime(sb.Name)

		// If no LastRequestTime event found, use creation time as fallback
		if lastRequestTime == 0 {
			klog.Warningf("Sandbox %v has no LastRequestTime event, use Created time", sb.Name)
			lastRequestTime = sb.CreatedAt.Unix()
		}

		idleTime := now - lastRequestTime

		klog.V(2).Infof("Sandbox %v idle check: lastRequestTime=%d, now=%d, idleTime=%d, idleTimeout=%d",
			sb.Name, lastRequestTime, now, idleTime, sbxIdleTimeout)

		// Check if sandbox has been idle for longer than IdleTimeout
		if idleTime < sbxIdleTimeout {
			continue
		}

		reason := "SandboxDeleted"
		message := fmt.Sprintf("Sandbox deleted due to idle timeout. %d/%d", idleTime, sbxIdleTimeout)
		if sb.AutoPause && config.CheckFeature(config.Cfg.PauseResume, sb.User) {
			if err := s.controller.Pause(sb, "idleTimeout"); err != nil {
				klog.Errorf("Failed to pause sandbox %v, error %v", sb.Name, err)
				reason = "SandboxPauseFailed"
				message = fmt.Sprintf("Failed to pause sandbox due to idle timeout. %d/%d, error: %v", idleTime, sbxIdleTimeout, err)
			} else {
				reason = "SandboxPaused"
				message = fmt.Sprintf("Sandbox paused due to idle timeout. %d/%d", idleTime, sbxIdleTimeout)
				klog.Infof("Paused sandbox %s due to idle timeout. IdleTime: %ds, IdleTimeout: %ds", sb.Name, idleTime, sbxIdleTimeout)
			}
		} else {
			klog.Infof("Sandbox %s has been idle for %d seconds (threshold: %d seconds), deleting sandbox",
				sb.Name, idleTime, sbxIdleTimeout)
			if err := s.controller.Delete(sb.Name); err != nil {
				reason = "SandboxDeleteFailed"
				message = fmt.Sprintf("Failed to delete sandbox due to idle timeout. %d/%d, error: %v", idleTime, sbxIdleTimeout, err)
				klog.Errorf("Failed to execute idle policy for sandbox %v, error %v", sb.Name, err)
			}
		}

		// Record event
		r := s.activator.Recorder()
		obj := &v1.ReplicaSet{
			TypeMeta: v1meta.TypeMeta{
				Kind:       "ReplicaSet",
				APIVersion: "apps/v1",
			},
			ObjectMeta: v1meta.ObjectMeta{
				Name:      sb.Name,
				Namespace: config.Cfg.SandboxNamespace,
			},
		}
		r.Event(obj, corev1.EventTypeWarning, reason, message)

		// to reduce kube-apiserver pressure, QPS is 100, max 30000 can be handled per 5 minutes.
		time.Sleep(10 * time.Millisecond)
	}
}

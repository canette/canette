package main

import (
	"os"
	"testing"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestLoadNamespacePolicy_Defaults(t *testing.T) {
	for _, k := range []string{"POD_SECURITY_ENFORCE", "POD_SECURITY_WARN", "POD_SECURITY_AUDIT", "POD_SECURITY_VERSION", "NAMESPACE_QUOTA_HARD", "NAMESPACE_LIMIT_RANGE_LIMITS"} {
		t.Setenv(k, "")
	}
	// t.Setenv above makes the test restore the originals afterwards. The PSA
	// variables must be unset, not empty: an empty level means "no label".
	unsetenv(t, "POD_SECURITY_ENFORCE", "POD_SECURITY_WARN", "POD_SECURITY_AUDIT", "POD_SECURITY_VERSION")

	p, err := loadNamespacePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if p.PodSecurity.Enforce != "baseline" || p.PodSecurity.Warn != "restricted" || p.PodSecurity.Audit != "restricted" {
		t.Errorf("defaults = %+v", p.PodSecurity)
	}
	if p.QuotaHard != nil || p.LimitRangeLimits != nil {
		t.Error("expected no quota or LimitRange by default")
	}
	if p.PodSecurity.Version != "latest" {
		t.Errorf("version = %q, want latest", p.PodSecurity.Version)
	}
}

func TestLoadNamespacePolicy_Version(t *testing.T) {
	t.Setenv("POD_SECURITY_VERSION", "v1.30")
	p, err := loadNamespacePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if p.PodSecurity.Version != "v1.30" {
		t.Errorf("version = %q, want v1.30", p.PodSecurity.Version)
	}
	for _, bad := range []string{"1.30", "v1.30.2", "v2.0", "newest"} {
		t.Setenv("POD_SECURITY_VERSION", bad)
		if _, err := loadNamespacePolicy(); err == nil {
			t.Errorf("expected an error for POD_SECURITY_VERSION=%q", bad)
		}
	}
}

func TestLoadNamespacePolicy_EmptyLevelAndJSON(t *testing.T) {
	t.Setenv("POD_SECURITY_ENFORCE", "restricted")
	t.Setenv("POD_SECURITY_WARN", "")
	t.Setenv("POD_SECURITY_AUDIT", "")
	t.Setenv("NAMESPACE_QUOTA_HARD", `{"requests.cpu":"4"}`)
	t.Setenv("NAMESPACE_LIMIT_RANGE_LIMITS", `[{"type":"Container"}]`)

	p, err := loadNamespacePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if p.PodSecurity.Enforce != "restricted" || p.PodSecurity.Warn != "" || p.PodSecurity.Audit != "" {
		t.Errorf("levels = %+v", p.PodSecurity)
	}
	if p.QuotaHard["requests.cpu"] != "4" {
		t.Errorf("quota = %v", p.QuotaHard)
	}
	if len(p.LimitRangeLimits) != 1 {
		t.Errorf("limits = %v", p.LimitRangeLimits)
	}
}

func TestLoadNamespacePolicy_Invalid(t *testing.T) {
	cases := map[string]string{
		"POD_SECURITY_ENFORCE":         "strict",
		"NAMESPACE_QUOTA_HARD":         `["not", "an", "object"]`,
		"NAMESPACE_LIMIT_RANGE_LIMITS": `{"not":"a list"}`,
	}
	for key, val := range cases {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, val)
			if _, err := loadNamespacePolicy(); err == nil {
				t.Errorf("expected an error for %s=%s", key, val)
			}
		})
	}
}

func TestWarningLogger_Dedupes(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	w := newWarningLogger(zap.New(core))
	w.HandleWarningHeader(299, "", "would violate PodSecurity \"restricted:latest\"")
	w.HandleWarningHeader(299, "", "would violate PodSecurity \"restricted:latest\"")
	w.HandleWarningHeader(299, "", "another warning")
	w.HandleWarningHeader(299, "", "")
	if n := logs.Len(); n != 2 {
		t.Errorf("logged %d warnings, want 2", n)
	}
}

func unsetenv(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if err := os.Unsetenv(k); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadWorkloadDefaults(t *testing.T) {
	t.Run("defaults match the chart", func(t *testing.T) {
		w, err := loadWorkloadDefaults()
		if err != nil {
			t.Fatal(err)
		}
		if w.TerminationGracePeriodSeconds == nil || *w.TerminationGracePeriodSeconds != 30 {
			t.Errorf("TerminationGracePeriodSeconds = %v, want 30", w.TerminationGracePeriodSeconds)
		}
		if w.CronJobTTLSecondsAfterFinished == nil || *w.CronJobTTLSecondsAfterFinished != 86400 {
			t.Errorf("CronJobTTLSecondsAfterFinished = %v, want 86400", w.CronJobTTLSecondsAfterFinished)
		}
	})

	t.Run("0 is a real value, -1 is unset", func(t *testing.T) {
		t.Setenv("CRONJOB_BACKOFF_LIMIT", "0")
		t.Setenv("REVISION_HISTORY_LIMIT", "-1")
		w, err := loadWorkloadDefaults()
		if err != nil {
			t.Fatal(err)
		}
		if w.CronJobBackoffLimit == nil || *w.CronJobBackoffLimit != 0 {
			t.Errorf("CronJobBackoffLimit = %v, want 0", w.CronJobBackoffLimit)
		}
		if w.RevisionHistoryLimit != nil {
			t.Errorf("RevisionHistoryLimit = %d, want unset", *w.RevisionHistoryLimit)
		}
	})

	for _, bad := range []string{"-2", "abc", "1.2096e+06"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			t.Setenv("CRONJOB_ACTIVE_DEADLINE_SECONDS", bad)
			if _, err := loadWorkloadDefaults(); err == nil {
				t.Errorf("expected an error for %q", bad)
			}
		})
	}
}

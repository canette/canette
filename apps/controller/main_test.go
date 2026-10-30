package main

import "testing"

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

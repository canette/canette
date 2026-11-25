//go:build lifecycle

package lifecycle

import (
	"fmt"
	"testing"
)

// blockedBy skips a scenario that waits on an open ticket. Remove the call
// when the ticket lands and write the test.
func blockedBy(t *testing.T, issue int, why string) {
	t.Helper()
	t.Skipf("blocked by https://github.com/canette/canette/issues/%d: %s", issue, why)
}

// Scenario 3 of #330: a delayed cleanup retry never deletes a new object that
// reuses the old one's name.
func TestSlugReuseAfterDelete(t *testing.T) {
	blockedBy(t, 333, "deletes don't check the object's UID yet")
}

func TestVolumeRecreateSameName(t *testing.T) {
	blockedBy(t, 333, "deletes don't check the object's UID yet")
}

// Scenario 6 of #330: each status names what Kubernetes actually reports.
func TestStatus(t *testing.T) {
	for _, c := range []struct {
		name  string
		issue int
	}{
		{"partial-replicas", 334},
		{"failed-rollout-old-serving", 332},
		{"httproute-rejected", 334},
		{"cronjob-never-run", 334},
	} {
		t.Run(c.name, func(t *testing.T) {
			blockedBy(t, c.issue, fmt.Sprintf("the %s status isn't reported yet", c.name))
		})
	}
}

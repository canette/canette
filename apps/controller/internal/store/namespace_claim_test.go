package store

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestClaimNamespaceDeletions(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, q := range []struct {
		id        string
		claimedAt any
		nextAt    any
	}{
		{"free", nil, nil},
		{"claimed", now, nil},
		{"expired", now.Add(-volumeDeletionClaimTTL - time.Minute), nil},
		{"blocked", nil, now.Add(time.Hour)},
	} {
		if _, err := db.Exec(`INSERT INTO queued_namespace_cleanups (id, project_id, project_slug, created_at, claimed_at, next_attempt_at)
			VALUES ($1, 'p1', $1, $2, $3, $4)`, q.id, now, q.claimedAt, q.nextAt); err != nil {
			t.Fatal(err)
		}
	}

	claimed := func() []string {
		t.Helper()
		dels, err := s.ClaimNamespaceDeletions(ctx, 10)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, d := range dels {
			if !d.ProjectExists {
				t.Errorf("%s: project p1 exists, ProjectExists is false", d.ID)
			}
			ids = append(ids, d.ID)
		}
		slices.Sort(ids)
		return ids
	}
	if got := claimed(); !slices.Equal(got, []string{"expired", "free"}) {
		t.Fatalf("claimed %v, want [expired free]", got)
	}
	if got := claimed(); len(got) != 0 {
		t.Errorf("claimed %v again while their claims last", got)
	}

	// A failed attempt gives the claim back; a blocked one too, until due.
	if err := s.ReleaseNamespaceDeletion(ctx, "free"); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkNamespaceBlocked(ctx, "expired", "holds PVCs: x", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := claimed(); !slices.Equal(got, []string{"free"}) {
		t.Errorf("after release: claimed %v, want [free]", got)
	}
	var claimedAt any
	if err := db.QueryRow(`SELECT claimed_at FROM queued_namespace_cleanups WHERE id = 'expired'`).Scan(&claimedAt); err != nil || claimedAt != nil {
		t.Errorf("blocked row keeps claim %v, err %v", claimedAt, err)
	}
}

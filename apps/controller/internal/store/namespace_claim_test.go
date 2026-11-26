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

	byID := map[string]PendingNamespaceDeletion{}
	claimed := func() []string {
		t.Helper()
		dels, err := s.ClaimNamespaceDeletions(ctx, 10)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, d := range dels {
			if d.ClaimToken == "" {
				t.Errorf("%s: claimed without a token", d.ID)
			}
			byID[d.ID] = d
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

	// A worker whose claim was taken over can't give it back, block it or
	// finish it.
	stale := byID["free"]
	stale.ClaimToken = "an earlier claim"
	for _, finish := range []func() error{
		func() error { return s.ReleaseNamespaceDeletion(ctx, stale) },
		func() error { return s.MarkNamespaceBlocked(ctx, stale, "holds PVCs: x", now.Add(time.Hour)) },
		func() error { return s.MarkNamespaceDeleted(ctx, stale) },
	} {
		if err := finish(); err != nil {
			t.Fatal(err)
		}
	}
	var token string
	if err := db.QueryRow(`SELECT claim_token FROM queued_namespace_cleanups WHERE id = 'free'`).Scan(&token); err != nil || token != byID["free"].ClaimToken {
		t.Errorf("a stale worker changed the claim: token %q, err %v", token, err)
	}

	// A failed attempt gives the claim back; a blocked one too, until due.
	if err := s.ReleaseNamespaceDeletion(ctx, byID["free"]); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkNamespaceBlocked(ctx, byID["expired"], "holds PVCs: x", now.Add(time.Hour)); err != nil {
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

func TestMarkNamespaceDeleted_NeedsTheClaim(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO queued_namespace_cleanups (id, project_id, project_slug, created_at)
		VALUES ('q', 'p1', 'old', $1)`, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	dels, err := s.ClaimNamespaceDeletions(ctx, 1)
	if err != nil || len(dels) != 1 {
		t.Fatalf("claimed %v, err %v", dels, err)
	}
	if err := s.MarkNamespaceDeleted(ctx, dels[0]); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM queued_namespace_cleanups`).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d rows left, err %v", n, err)
	}
}

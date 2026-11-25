package failpoint

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// exitRecorder replaces os.Exit and records each status it was called with.
type exitRecorder []int

func (r *exitRecorder) exit(code int) { *r = append(*r, code) }

func TestHitUnarmedDoesNothing(t *testing.T) {
	var exits exitRecorder
	newSet("", "", exits.exit).hit("after-claim")
	newSet("after-apply", t.TempDir(), exits.exit).hit("after-claim")
	if len(exits) != 0 {
		t.Fatalf("exits = %v, want none", exits)
	}
}

// A restarted container sees the marker the first run left and carries on.
func TestHitFiresOncePerDir(t *testing.T) {
	dir := t.TempDir()
	var exits exitRecorder
	newSet("after-claim", dir, exits.exit).hit("after-claim")
	if !slices.Equal(exits, exitRecorder{ExitCode}) {
		t.Fatalf("first hit exits = %v, want [%d]", exits, ExitCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "after-claim")); err != nil {
		t.Fatalf("marker not written: %v", err)
	}

	restarted := newSet("after-claim", dir, exits.exit)
	if got := restarted.armed(); len(got) != 0 {
		t.Errorf("armed after restart = %v, want none", got)
	}
	restarted.hit("after-claim")
	if len(exits) != 1 {
		t.Fatalf("hit after restart exited again: %v", exits)
	}
}

func TestNamesAreTrimmedAndIndependent(t *testing.T) {
	dir := t.TempDir()
	var exits exitRecorder
	s := newSet(" after-claim , ,after-app-delete ", dir, exits.exit)
	if got, want := s.armed(), []string{"after-claim", "after-app-delete"}; !slices.Equal(got, want) {
		t.Fatalf("armed = %v, want %v", got, want)
	}
	s.hit("after-app-delete")
	if got, want := s.armed(), []string{"after-claim"}; !slices.Equal(got, want) {
		t.Errorf("armed after one fired = %v, want %v", got, want)
	}
	s.hit("after-claim")
	if len(exits) != 2 {
		t.Errorf("exits = %v, want two", exits)
	}
}

// Without a marker the failpoint would fire on every restart.
func TestHitWithUnwritableDirDoesNotFire(t *testing.T) {
	var exits exitRecorder
	newSet("after-claim", filepath.Join(t.TempDir(), "missing"), exits.exit).hit("after-claim")
	if len(exits) != 0 {
		t.Fatalf("exits = %v, want none", exits)
	}
}

func TestValidate(t *testing.T) {
	if err := newSet("after-claim", "", os.Exit).validate(); err == nil {
		t.Error("names without a dir: want an error")
	}
	if err := newSet("", "", os.Exit).validate(); err != nil {
		t.Errorf("unarmed: %v", err)
	}
	if err := newSet("after-claim", t.TempDir(), os.Exit).validate(); err != nil {
		t.Errorf("names with a dir: %v", err)
	}
}

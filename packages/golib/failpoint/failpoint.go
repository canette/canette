// Package failpoint lets live-cluster tests crash a process at a named point,
// to check that work interrupted there is recovered after a restart.
//
// CANETTE_FAILPOINTS lists the armed points, comma-separated. Each fires once:
// before exiting, Hit records the point in CANETTE_FAILPOINT_DIR, which should
// outlive the container (an emptyDir), so the restarted process skips it and
// finishes the work. With CANETTE_FAILPOINTS unset, Hit does nothing.
package failpoint

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

const (
	namesEnv = "CANETTE_FAILPOINTS"
	dirEnv   = "CANETTE_FAILPOINT_DIR"
)

// ExitCode is the status a fired failpoint exits with, the same as a SIGKILL.
const ExitCode = 137

type set struct {
	names []string
	dir   string
	exit  func(int)
	mu    sync.Mutex
}

var fromEnv = sync.OnceValue(func() *set {
	return newSet(os.Getenv(namesEnv), os.Getenv(dirEnv), os.Exit)
})

func newSet(names, dir string, exit func(int)) *set {
	s := &set{dir: dir, exit: exit}
	for _, n := range strings.Split(names, ",") {
		if n = strings.TrimSpace(n); n != "" {
			s.names = append(s.names, n)
		}
	}
	return s
}

// Hit exits the process with ExitCode if the named failpoint is armed and has
// not fired yet. Deferred functions don't run, as if the process was killed.
func Hit(name string) { fromEnv().hit(name) }

// Armed returns the failpoints that are armed and have not fired yet, for
// logging at startup.
func Armed() []string { return fromEnv().armed() }

// Validate reports a failpoint configuration that would crash on every
// restart instead of once.
func Validate() error { return fromEnv().validate() }

func (s *set) validate() error {
	if len(s.names) > 0 && s.dir == "" {
		return fmt.Errorf("%s is set without %s", namesEnv, dirEnv)
	}
	return nil
}

func (s *set) armed() []string {
	var out []string
	for _, n := range s.names {
		if !s.fired(n) {
			out = append(out, n)
		}
	}
	return out
}

func (s *set) fired(name string) bool {
	if s.dir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(s.dir, name))
	return err == nil
}

func (s *set) hit(name string) {
	if !slices.Contains(s.names, name) {
		return
	}
	// Held until exit, so a concurrent Hit blocks instead of running on.
	s.mu.Lock()
	if s.dir != "" {
		f, err := os.OpenFile(filepath.Join(s.dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, fs.ErrExist) {
			s.mu.Unlock()
			return
		}
		if err != nil {
			// Firing without a marker would crash again after the restart.
			fmt.Fprintf(os.Stderr, "failpoint %s: not firing, cannot record it: %v\n", name, err)
			s.mu.Unlock()
			return
		}
		_ = f.Close()
	}
	fmt.Fprintf(os.Stderr, "failpoint %s: exiting with status %d\n", name, ExitCode)
	s.exit(ExitCode)
	// Only reached when exit is replaced in tests.
	s.mu.Unlock()
}

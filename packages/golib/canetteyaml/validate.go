package canetteyaml

import (
	"fmt"
	"path"
	"regexp"
)

// Limits enforced by BuildSpec.Validate. tools/canette-schema reads these
// constants and patterns to generate the matching schema constraints.
const (
	MaxBuildValueLen = 1024
	MaxArgKeyLen     = 256
	MaxArgCount      = 32
)

// SafePathPattern allows only characters that are safe in filesystem paths.
// Excludes shell metacharacters: ; | & ` $ < > ( ) { } \n \r etc.
const SafePathPattern = `^[a-zA-Z0-9./_-]*$`

// ArgKeyPattern matches valid Docker ARG names: letter or underscore, followed
// by letters, digits, or underscores. Matches the Dockerfile ARG name spec.
const ArgKeyPattern = `^[a-zA-Z_][a-zA-Z0-9_]*$`

var (
	safePathRe = regexp.MustCompile(SafePathPattern)
	argKeyRe   = regexp.MustCompile(ArgKeyPattern)
)

// Validate checks that all BuildSpec field values are safe to pass to BuildKit.
// Empty path values are allowed (they mean "use the default"). Returns an
// error if any value exceeds the max length or contains disallowed characters.
func (b BuildSpec) Validate() error {
	for _, f := range []struct{ name, value string }{
		{"dockerfile", b.Dockerfile},
		{"context", b.Context},
	} {
		if len(f.value) > MaxBuildValueLen {
			return fmt.Errorf("build.%s exceeds maximum length of %d", f.name, MaxBuildValueLen)
		}
		if f.value != "" && !safePathRe.MatchString(f.value) {
			return fmt.Errorf("build.%s contains invalid characters (only alphanumeric, ., /, _, - allowed)", f.name)
		}
	}

	if len(b.Args) > MaxArgCount {
		return fmt.Errorf("build.args exceeds maximum of %d entries", MaxArgCount)
	}
	for k, v := range b.Args {
		if !argKeyRe.MatchString(k) {
			return fmt.Errorf("build.args key %q is invalid: must match [a-zA-Z_][a-zA-Z0-9_]*", k)
		}
		if len(k) > MaxArgKeyLen {
			return fmt.Errorf("build.args key %q exceeds maximum length of %d", k, MaxArgKeyLen)
		}
		if len(v) > MaxBuildValueLen {
			return fmt.Errorf("build.args value for %q exceeds maximum length of %d", k, MaxBuildValueLen)
		}
	}
	return nil
}

// Hardened-mode limits enforced by SecuritySpec.Validate and mirrored in the
// generated schema.
const (
	// DefaultHardenedUser is the UID and GID used in hardened mode when
	// security.user is not set.
	DefaultHardenedUser int64 = 10001
	// MaxID is the largest UID/GID Kubernetes accepts.
	MaxID int64 = 2147483647
	// MaxWritablePaths caps security.writable_paths.
	MaxWritablePaths = 16
)

// WritablePathPattern matches an absolute path made of safe characters.
const WritablePathPattern = `^/[a-zA-Z0-9./_-]*$`

var writablePathRe = regexp.MustCompile(WritablePathPattern)

// Validate checks the security block. Messages name the field, since they are
// shown to the user as the reason a deployment failed.
func (s SecuritySpec) Validate() error {
	if s.User != nil {
		if *s.User == 0 {
			return fmt.Errorf("security.user must not be 0 (root); leave it out to use %d", DefaultHardenedUser)
		}
		if *s.User < 0 || *s.User > MaxID {
			return fmt.Errorf("security.user must be between 1 and %d", MaxID)
		}
	}
	if len(s.WritablePaths) > MaxWritablePaths {
		return fmt.Errorf("security.writable_paths has %d entries, the maximum is %d", len(s.WritablePaths), MaxWritablePaths)
	}
	seen := make(map[string]bool, len(s.WritablePaths))
	for _, p := range s.WritablePaths {
		switch {
		case len(p) > MaxBuildValueLen:
			return fmt.Errorf("security.writable_paths entry exceeds maximum length of %d", MaxBuildValueLen)
		case !writablePathRe.MatchString(p):
			return fmt.Errorf("security.writable_paths entry %q must be an absolute path (starting with /) using only letters, digits, ., /, _ and -", p)
		case p == "/":
			return fmt.Errorf("security.writable_paths entry %q is the root directory; set read_only_root_filesystem: false instead", p)
		case path.Clean(p) != p:
			return fmt.Errorf("security.writable_paths entry %q is not a clean path; use %q", p, path.Clean(p))
		case seen[p]:
			return fmt.Errorf("security.writable_paths lists %q more than once", p)
		}
		seen[p] = true
	}
	return nil
}

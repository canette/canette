package canetteyaml

import (
	"fmt"
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

package config

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestResolveSecurity(t *testing.T) {
	tests := []struct {
		name     string
		yaml     string
		want     *Hardening
		warnings []string
	}{
		{name: "empty config", yaml: ""},
		{name: "no security block", yaml: "replicas: 2\n"},
		{name: "hardened false", yaml: "security:\n  hardened: false\n"},
		{name: "unparseable yaml is not a security error", yaml: "security: [\n"},
		{name: "top-level list is not a security error", yaml: "- a\n- b\n"},
		{
			name: "defaults",
			yaml: "security:\n  hardened: true\n",
			want: &Hardening{User: 10001, ReadOnlyRootFS: true, WritablePaths: []string{"/tmp"}},
		},
		{
			name: "all overrides",
			yaml: "security:\n  hardened: true\n  user: 1000\n  writable_paths: [/tmp, /app/.next/cache]\n",
			want: &Hardening{User: 1000, ReadOnlyRootFS: true, WritablePaths: []string{"/tmp", "/app/.next/cache"}},
		},
		{
			name: "no writable paths",
			yaml: "security:\n  hardened: true\n  writable_paths: []\n",
			want: &Hardening{User: 10001, ReadOnlyRootFS: true, WritablePaths: []string{}},
		},
		{
			name: "writable rootfs",
			yaml: "security:\n  hardened: true\n  read_only_root_filesystem: false\n",
			want: &Hardening{User: 10001},
		},
		{
			name:     "writable rootfs ignores writable_paths",
			yaml:     "security:\n  hardened: true\n  read_only_root_filesystem: false\n  writable_paths: [/data]\n",
			want:     &Hardening{User: 10001},
			warnings: []string{"security.writable_paths ignored because security.read_only_root_filesystem is false"},
		},
		{
			name:     "settings without hardened",
			yaml:     "security:\n  user: 1000\n  writable_paths: [/tmp]\n",
			warnings: []string{"security.writable_paths, security.user ignored because security.hardened is not true"},
		},
		{
			name: "other invalid fields don't hide security",
			yaml: "replicas: lots\nsecurity:\n  hardened: true\n",
			want: &Hardening{User: 10001, ReadOnlyRootFS: true, WritablePaths: []string{"/tmp"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, warnings, err := ResolveSecurity(tc.yaml)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("hardening = %+v, want %+v", got, tc.want)
			}
			if !reflect.DeepEqual(warnings, tc.warnings) {
				t.Errorf("warnings = %q, want %q", warnings, tc.warnings)
			}
		})
	}
}

func TestResolveSecurityErrors(t *testing.T) {
	for _, tc := range []struct{ name, yaml, want string }{
		{"wrong type", "security:\n  hardened: true\n  user: abc\n", "security.user must be a whole number"},
		{"root user", "security:\n  hardened: true\n  user: 0\n", "security.user must not be 0"},
		{"relative path", "security:\n  hardened: true\n  writable_paths: [tmp]\n", "must be an absolute path"},
		{"invalid even when not hardened", "security:\n  user: -5\n", "security.user must be between"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ResolveSecurity(tc.yaml)
			var secErr *SecurityError
			if !errors.As(err, &secErr) {
				t.Fatalf("err = %v (%T), want *SecurityError", err, err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %q, want it to contain %q", err, tc.want)
			}
		})
	}
}

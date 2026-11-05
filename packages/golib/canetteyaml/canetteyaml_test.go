package canetteyaml

import (
	"fmt"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Config inlines BuildConfig and RuntimeConfig, so a full canette.yaml must
// decode into all three types with the same field values.
func TestConfigDecodesInlineParts(t *testing.T) {
	input := `
build:
  dockerfile: Dockerfile
runtime:
  port: 8080
  command: [sleep, 3600]
replicas: 2
secrets: [DATABASE_URL]
env:
  WORKERS: 4
  DEBUG: true
resources:
  requests:
    cpu: 0.5
  limits:
    cpu: 1
    memory: 1073741824
unknown_field: ignored
`
	var full Config
	if err := yaml.Unmarshal([]byte(input), &full); err != nil {
		t.Fatalf("decode Config: %v", err)
	}
	if full.Build.Dockerfile != "Dockerfile" || *full.Runtime.Port != 8080 || *full.Replicas != 2 || full.Secrets[0] != "DATABASE_URL" {
		t.Errorf("unexpected Config: %+v", full)
	}

	// The schema allows numbers and booleans in env; they must decode as strings.
	if full.Env["WORKERS"] != "4" || full.Env["DEBUG"] != "true" {
		t.Errorf("env = %v, want WORKERS=4 DEBUG=true", full.Env)
	}

	// The schema allows bare numbers for quantities and command items; they
	// must decode as strings.
	if full.Resources.Requests.CPU != "0.5" || full.Resources.Limits.CPU != "1" || full.Resources.Limits.Memory != "1073741824" {
		t.Errorf("resources = %+v, want cpu 0.5/1 and memory 1073741824", full.Resources)
	}
	if strings.Join(full.Runtime.Command, " ") != "sleep 3600" {
		t.Errorf("command = %v, want [sleep 3600]", full.Runtime.Command)
	}

	var rt RuntimeConfig
	if err := yaml.Unmarshal([]byte(input), &rt); err != nil {
		t.Fatalf("decode RuntimeConfig: %v", err)
	}
	if *rt.Runtime.Port != 8080 {
		t.Errorf("RuntimeConfig port = %d, want 8080", *rt.Runtime.Port)
	}

	var bc BuildConfig
	if err := yaml.Unmarshal([]byte(input), &bc); err != nil {
		t.Fatalf("decode BuildConfig: %v", err)
	}
	if bc.Build.Dockerfile != "Dockerfile" {
		t.Errorf("BuildConfig dockerfile = %q, want Dockerfile", bc.Build.Dockerfile)
	}
}

func TestBuildSpecValidate(t *testing.T) {
	tests := []struct {
		name    string
		spec    BuildSpec
		wantErr bool
	}{
		{"zero value is valid", BuildSpec{}, false},
		{"normal dockerfile", BuildSpec{Dockerfile: "docker/App.dockerfile"}, false},
		{"normal context", BuildSpec{Context: "./src"}, false},
		{"both fields", BuildSpec{Dockerfile: "Dockerfile", Context: "./app"}, false},
		{"shell command injection in context", BuildSpec{Context: "$(ls)"}, true},
		{"variable injection via newline", BuildSpec{Context: ".\nEVIL=1"}, true},
		{"single quote in dockerfile", BuildSpec{Dockerfile: "path/to/it's.dockerfile"}, true},
		{"semicolon in context", BuildSpec{Context: "./app;rm -rf /"}, true},
		{"pipe in dockerfile", BuildSpec{Dockerfile: "Dockerfile|cat /etc/passwd"}, true},
		{"value too long", BuildSpec{Dockerfile: strings.Repeat("a", MaxBuildValueLen+1)}, true},
		// build.args validation
		{"valid args", BuildSpec{Args: map[string]string{"NODE_ENV": "production", "PORT": "3000"}}, false},
		{"args key with equals sign", BuildSpec{Args: map[string]string{"FOO=BAR": "value"}}, true},
		{"args empty key", BuildSpec{Args: map[string]string{"": "value"}}, true},
		{"args key starts with digit", BuildSpec{Args: map[string]string{"1FOO": "value"}}, true},
		{"args key with hyphen", BuildSpec{Args: map[string]string{"MY-ARG": "value"}}, true},
		{"args value too long", BuildSpec{Args: map[string]string{"KEY": strings.Repeat("a", MaxBuildValueLen+1)}}, true},
		{"args too many entries", BuildSpec{Args: func() map[string]string {
			m := make(map[string]string, MaxArgCount+1)
			for i := range MaxArgCount + 1 {
				m[fmt.Sprintf("ARG_%d", i)] = "value"
			}
			return m
		}()}, true},
		{"args exactly at limit", BuildSpec{Args: func() map[string]string {
			m := make(map[string]string, MaxArgCount)
			for i := range MaxArgCount {
				m[fmt.Sprintf("ARG_%d", i)] = "value"
			}
			return m
		}()}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.spec.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSecuritySpecDecode(t *testing.T) {
	decode := func(t *testing.T, input string) (RuntimeConfig, error) {
		t.Helper()
		var rt RuntimeConfig
		err := yaml.Unmarshal([]byte(input), &rt)
		return rt, err
	}

	t.Run("absent", func(t *testing.T) {
		rt, err := decode(t, "replicas: 1\n")
		if err != nil || rt.Security != nil {
			t.Fatalf("got %+v, %v; want nil security", rt.Security, err)
		}
	})

	t.Run("all fields", func(t *testing.T) {
		rt, err := decode(t, `
security:
  hardened: true
  writable_paths: [/tmp, /app/.next/cache]
  read_only_root_filesystem: false
  user: 1000
  future_field: ignored
`)
		if err != nil {
			t.Fatal(err)
		}
		s := rt.Security
		if s == nil || !*s.Hardened || *s.ReadOnlyRootFilesystem || *s.User != 1000 ||
			strings.Join(s.WritablePaths, ",") != "/tmp,/app/.next/cache" {
			t.Fatalf("unexpected security: %+v", s)
		}
	})

	t.Run("empty writable_paths is non-nil", func(t *testing.T) {
		rt, err := decode(t, "security:\n  hardened: true\n  writable_paths: []\n")
		if err != nil {
			t.Fatal(err)
		}
		if rt.Security.WritablePaths == nil || len(rt.Security.WritablePaths) != 0 {
			t.Fatalf("writable_paths = %#v, want empty non-nil", rt.Security.WritablePaths)
		}
	})

	t.Run("nulls count as absent", func(t *testing.T) {
		rt, err := decode(t, "security:\n  hardened: true\n  user: ~\n  writable_paths: null\n")
		if err != nil {
			t.Fatal(err)
		}
		if rt.Security.User != nil || rt.Security.WritablePaths != nil {
			t.Fatalf("unexpected security: %+v", rt.Security)
		}
	})

	// Anchors and aliases are ordinary YAML and must decode like values
	// written in place.
	for _, tc := range []struct{ name, input string }{
		{"scalar alias", "on: &on true\nuid: &uid 1000\nsecurity:\n  hardened: *on\n  user: *uid\n  writable_paths: [/tmp]\n"},
		{"list alias", "on: &on true\npaths: &p [/tmp]\nsecurity:\n  hardened: *on\n  user: 1000\n  writable_paths: *p\n"},
		{"item alias", "tmp: &t /tmp\nsecurity:\n  hardened: true\n  user: 1000\n  writable_paths: [*t]\n"},
		{"block alias", "base: &b {hardened: true, user: 1000, writable_paths: [/tmp]}\nsecurity: *b\n"},
		{"merge key", "base: &b {hardened: true, writable_paths: [/tmp]}\nsecurity:\n  <<: *b\n  user: 1000\n"},
	} {
		t.Run("alias: "+tc.name, func(t *testing.T) {
			rt, err := decode(t, tc.input)
			if err != nil {
				t.Fatal(err)
			}
			s := rt.Security
			if s == nil || s.Hardened == nil || !*s.Hardened || s.User == nil || *s.User != 1000 ||
				strings.Join(s.WritablePaths, ",") != "/tmp" {
				t.Fatalf("unexpected security: %+v", s)
			}
		})
	}

	// An alias to a wrong type still gets the field-named message.
	if _, err := decode(t, "m: &m {a: 1}\nsecurity:\n  hardened: *m\n"); err == nil ||
		!strings.Contains(err.Error(), "security.hardened must be true or false") {
		t.Errorf("alias to a mapping: err = %v", err)
	}

	for _, tc := range []struct{ name, input, wantErr string }{
		{"user not a number", "security:\n  user: abc\n", "security.user must be a whole number"},
		{"user fraction", "security:\n  user: 1.5\n", "security.user must be a whole number"},
		{"hardened not a bool", "security:\n  hardened: maybe\n", "security.hardened must be true or false"},
		{"read-only not a bool", "security:\n  read_only_root_filesystem: [x]\n", "security.read_only_root_filesystem must be true or false"},
		{"writable_paths scalar", "security:\n  writable_paths: /tmp\n", "security.writable_paths must be a list"},
		{"writable_paths nested", "security:\n  writable_paths: [[/tmp]]\n", "security.writable_paths must be a list"},
		{"security scalar", "security: true\n", "security must be a mapping"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decode(t, tc.input)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestSecuritySpecValidate(t *testing.T) {
	i64 := func(v int64) *int64 { return &v }
	tooMany := make([]string, MaxWritablePaths+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("/p%d", i)
	}
	tests := []struct {
		name    string
		spec    SecuritySpec
		wantErr string
	}{
		{"zero value", SecuritySpec{}, ""},
		{"user 1", SecuritySpec{User: i64(1)}, ""},
		{"user max", SecuritySpec{User: i64(MaxID)}, ""},
		{"user 0", SecuritySpec{User: i64(0)}, "must not be 0"},
		{"user negative", SecuritySpec{User: i64(-1)}, "between 1 and"},
		{"user too large", SecuritySpec{User: i64(MaxID + 1)}, "between 1 and"},
		{"paths ok", SecuritySpec{WritablePaths: []string{"/tmp", "/app/.next/cache", "/var/run"}}, ""},
		{"path relative", SecuritySpec{WritablePaths: []string{"tmp"}}, "absolute path"},
		{"path with space", SecuritySpec{WritablePaths: []string{"/my dir"}}, "absolute path"},
		{"path root", SecuritySpec{WritablePaths: []string{"/"}}, "root directory"},
		{"path trailing slash", SecuritySpec{WritablePaths: []string{"/tmp/"}}, "not a clean path"},
		{"path dot-dot", SecuritySpec{WritablePaths: []string{"/app/../etc"}}, "not a clean path"},
		{"path duplicate", SecuritySpec{WritablePaths: []string{"/tmp", "/tmp"}}, "more than once"},
		{"too many paths", SecuritySpec{WritablePaths: tooMany}, "maximum is"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.spec.Validate()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

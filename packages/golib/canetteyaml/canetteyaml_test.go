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

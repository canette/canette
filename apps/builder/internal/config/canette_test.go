package config

import (
	"fmt"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestParseBuildSpec(t *testing.T) {
	input := `
build:
  dockerfile: docker/Prod.dockerfile
  context: ./src
  args:
    NODE_ENV: production
`
	var cfg CanetteConfig
	if err := yaml.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}

	if cfg.Build.Dockerfile != "docker/Prod.dockerfile" {
		t.Errorf("Dockerfile = %q, want %q", cfg.Build.Dockerfile, "docker/Prod.dockerfile")
	}
	if cfg.Build.Context != "./src" {
		t.Errorf("Context = %q, want %q", cfg.Build.Context, "./src")
	}
	if cfg.Build.Args["NODE_ENV"] != "production" {
		t.Errorf("Args[NODE_ENV] = %q, want %q", cfg.Build.Args["NODE_ENV"], "production")
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
		{"value too long", BuildSpec{Dockerfile: strings.Repeat("a", maxBuildValueLen+1)}, true},
		// build.args validation
		{"valid args", BuildSpec{Args: map[string]string{"NODE_ENV": "production", "PORT": "3000"}}, false},
		{"args key with equals sign", BuildSpec{Args: map[string]string{"FOO=BAR": "value"}}, true},
		{"args empty key", BuildSpec{Args: map[string]string{"": "value"}}, true},
		{"args key starts with digit", BuildSpec{Args: map[string]string{"1FOO": "value"}}, true},
		{"args key with hyphen", BuildSpec{Args: map[string]string{"MY-ARG": "value"}}, true},
		{"args value too long", BuildSpec{Args: map[string]string{"KEY": strings.Repeat("a", maxBuildValueLen+1)}}, true},
		{"args too many entries", BuildSpec{Args: func() map[string]string {
			m := make(map[string]string, maxArgCount+1)
			for i := range maxArgCount + 1 {
				m[fmt.Sprintf("ARG_%d", i)] = "value"
			}
			return m
		}()}, true},
		{"args exactly at limit", BuildSpec{Args: func() map[string]string {
			m := make(map[string]string, maxArgCount)
			for i := range maxArgCount {
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

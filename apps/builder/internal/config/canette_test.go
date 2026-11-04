package config

import (
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

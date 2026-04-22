package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"canette.dev/builder/internal/config"
)

const maxCanetteYAMLSize = 5 * 1024 // Should match config/canette.go

func TestValidateInputs(t *testing.T) {
	validArgs := []string{"myproject/myapp", "registry.example.com/", "git-abc1234", "tcp://buildkitd.svc:1234"}

	tests := []struct {
		name         string
		appName      string
		imageRepo    string
		imageTag     string
		buildkitHost string
		wantErr      bool
	}{
		{"all valid", validArgs[0], validArgs[1], validArgs[2], validArgs[3], false},
		{"invalid app name — uppercase", "MyProject/myapp", validArgs[1], validArgs[2], validArgs[3], true},
		{"invalid app name — no slash", "myprojectmyapp", validArgs[1], validArgs[2], validArgs[3], true},
		{"empty image repo", validArgs[0], "", validArgs[2], validArgs[3], true},
		{"image repo with semicolon", validArgs[0], "registry.example.com/;rm -rf /", validArgs[2], validArgs[3], true},
		{"image tag wrong format", validArgs[0], validArgs[1], "latest", validArgs[3], true},
		{"image tag too short sha", validArgs[0], validArgs[1], "git-abc123", validArgs[3], true},
		{"invalid buildkit host", validArgs[0], validArgs[1], validArgs[2], "http://buildkitd:1234", true},
		{"unix socket buildkit", validArgs[0], validArgs[1], validArgs[2], "unix:///run/buildkit/buildkitd.sock", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateInputs(tt.appName, tt.imageRepo, tt.imageTag, tt.buildkitHost)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateInputs() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestResolveAppPath(t *testing.T) {
	workspace := "/workspace"

	tests := []struct {
		name       string
		appPath    string
		wantErr    bool
		wantResult string
	}{
		{"empty path returns workspace", "", false, workspace},
		{"subdirectory", "myapp", false, "/workspace/myapp"},
		{"nested", "apps/frontend", false, "/workspace/apps/frontend"},
		{"traversal attack", "../etc/passwd", true, ""},
		{"absolute path traversal", "/etc/passwd", true, ""},
		{"complex traversal", "a/../../etc", true, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveAppPath(workspace, tt.appPath)
			if (err != nil) != tt.wantErr {
				t.Fatalf("resolveAppPath() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.wantResult {
				t.Errorf("resolveAppPath() = %q, want %q", got, tt.wantResult)
			}
		})
	}
}

func TestParseCanetteConfig(t *testing.T) {
	dir := t.TempDir()

	t.Run("missing file returns zero config", func(t *testing.T) {
		cfg, err := config.ParseFile(filepath.Join(dir, "nonexistent.yaml"))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Build.Dockerfile != "" || cfg.Build.Context != "" {
			t.Errorf("expected zero config, got %+v", cfg)
		}
	})

	t.Run("valid config parsed", func(t *testing.T) {
		path := filepath.Join(dir, "canette.yaml")
		os.WriteFile(path, []byte("build:\n  dockerfile: docker/App.dockerfile\n  context: ./app\n"), 0644)

		cfg, err := config.ParseFile(path)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Build.Dockerfile != "docker/App.dockerfile" {
			t.Errorf("Dockerfile = %q, want %q", cfg.Build.Dockerfile, "docker/App.dockerfile")
		}
		if cfg.Build.Context != "./app" {
			t.Errorf("Context = %q, want %q", cfg.Build.Context, "./app")
		}
	})

	t.Run("invalid yaml returns error", func(t *testing.T) {
		path := filepath.Join(dir, "invalid.yaml")
		os.WriteFile(path, []byte("build: [invalid: yaml:"), 0644)
		if _, err := config.ParseFile(path); err == nil {
			t.Error("expected error, got nil")
		}
	})

	t.Run("oversized file rejected", func(t *testing.T) {
		path := filepath.Join(dir, "big.yaml")
		os.WriteFile(path, []byte("build:\n  context: "+strings.Repeat("a", maxCanetteYAMLSize)), 0644)
		if _, err := config.ParseFile(path); err == nil {
			t.Error("expected size error, got nil")
		}
	})
}

package registry

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildDockerConfigJSON_HostnameOnly(t *testing.T) {
	// IMAGE_REPO includes a path prefix after the hostname, e.g.
	// "123456789012.dkr.ecr.us-east-1.amazonaws.com/canette/"
	// The auths key in config.json must be the bare hostname — Docker and
	// buildctl match credentials by registry host, not by image path.
	tests := []struct {
		name      string
		imageRepo string
		wantHost  string
	}{
		{
			name:      "ECR with path prefix",
			imageRepo: "123456789012.dkr.ecr.us-east-1.amazonaws.com/canette/",
			wantHost:  "123456789012.dkr.ecr.us-east-1.amazonaws.com",
		},
		{
			name:      "ECR without path prefix",
			imageRepo: "123456789012.dkr.ecr.us-east-1.amazonaws.com/",
			wantHost:  "123456789012.dkr.ecr.us-east-1.amazonaws.com",
		},
		{
			name:      "generic registry with path",
			imageRepo: "registry.example.com/myorg/",
			wantHost:  "registry.example.com",
		},
	}

	auth := &AuthConfig{Username: "AWS", Password: "token"}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out, err := BuildDockerConfigJSON(tc.imageRepo, auth)
			if err != nil {
				t.Fatalf("BuildDockerConfigJSON error: %v", err)
			}

			var cfg DockerConfigJSON
			if err := json.Unmarshal([]byte(out), &cfg); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if _, ok := cfg.Auths[tc.wantHost]; !ok {
				keys := make([]string, 0, len(cfg.Auths))
				for k := range cfg.Auths {
					keys = append(keys, k)
				}
				t.Errorf("auths key = %v, want %q (must be hostname only, no path)", keys, tc.wantHost)
			}

			for k := range cfg.Auths {
				if strings.Contains(k, "/") {
					t.Errorf("auths key %q contains a path — must be hostname only", k)
				}
			}
		})
	}
}

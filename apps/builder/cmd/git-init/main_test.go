package main

import "testing"

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"valid https", "https://github.com/user/repo.git", false},
		{"valid https with path", "https://gitlab.com/group/subgroup/repo", false},
		{"valid ssh scp", "git@github.com:user/repo.git", false},
		{"valid ssh scp no extension", "git@gitlab.com:group/repo", false},
		{"valid ssh scheme", "ssh://git@github.com/user/repo.git", false},
		{"valid ssh scheme no extension", "ssh://git@gitlab.com/group/repo", false},
		{"empty", "", true},
		{"http not allowed", "http://github.com/user/repo", true},
		{"semicolon injection", "https://github.com/user/repo;rm -rf /", true},
		{"pipe injection", "https://github.com/user/repo|cat /etc/passwd", true},
		{"dollar injection", "https://github.com/user/repo$HOME", true},
		{"backtick injection", "https://github.com/user/`id`", true},
		{"newline injection", "https://github.com/user/repo\nBAD=1", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateURL(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}

func TestValidateRef(t *testing.T) {
	tests := []struct {
		name    string
		ref     string
		wantErr bool
	}{
		{"main branch", "main", false},
		{"feature branch", "feature/my-feature", false},
		{"tag with dots", "v1.2.3", false},
		{"short sha", "abc1234", false},
		{"empty", "", true},
		{"starts with dash", "-main", true},
		{"double dot traversal", "main..evil", true},
		{"shell special", "main;rm -rf /", true},
		{"backtick", "main`id`", true},
		{"newline", "main\nevil", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateRef(tt.ref)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateRef(%q) error = %v, wantErr %v", tt.ref, err, tt.wantErr)
			}
		})
	}
}

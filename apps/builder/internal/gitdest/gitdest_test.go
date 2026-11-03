package gitdest

import "testing"

func TestCheck(t *testing.T) {
	cases := []struct {
		name               string
		allowed            string
		provider, credType string
		gitURL             string
		wantOK             bool
	}{
		{"github pat on github", "", "github", "pat", "https://github.com/a/b.git", true},
		{"github app on github", "", "github", "github_app", "https://github.com/a/b", true},
		{"uppercase host and default port", "", "github", "pat", "https://GitHub.com:443/a/b", true},
		{"gitlab pat on gitlab", "", "gitlab", "pat", "https://gitlab.com/a/b.git", true},
		{"github pat on gitlab", "", "github", "pat", "https://gitlab.com/a/b.git", false},
		{"github app on attacker", "", "github", "github_app", "https://attacker.example/a/b", false},
		{"gitea pat not allowlisted", "", "gitea", "pat", "https://git.example.com/a/b", false},
		{"generic pat not allowlisted", "", "generic", "pat", "https://git.example.com/a/b", false},
		{"gitea pat allowlisted", "https://other.example, https://git.example.com", "gitea", "pat", "https://git.example.com/a/b", true},
		{"port must match", "https://git.example.com:3443", "gitea", "pat", "https://git.example.com/a/b", false},
		{"port matches", "https://git.example.com:3443", "gitea", "pat", "https://git.example.com:3443/a/b", true},
		{"allowlist never admits github app", "https://git.example.com", "github", "github_app", "https://git.example.com/a/b", false},
		{"plain http rejected", "https://git.example.com", "gitea", "pat", "http://git.example.com/a/b", false},
		{"invalid allowlist entries ignored", "http://git.example.com,https://git.example.com/path", "gitea", "pat", "https://git.example.com/a/b", false},
		{"userinfo in allowlist ignored", "https://u:p@git.example.com", "gitea", "pat", "https://git.example.com/a/b", false},
		{"no slashes", "", "github", "pat", "https:attacker.example/a/b", false},
		{"one slash", "", "github", "pat", "https:/attacker.example/a/b", false},
		{"backslash", "", "github", "pat", `https://github.com\@attacker.example/a/b`, false},
		{"userinfo", "", "github", "pat", "https://user@github.com/a/b", false},
		{"userinfo with port-like password", "", "github", "pat", "https://github.com:x@attacker.example/a/b", false},
		{"ftp", "", "github", "pat", "ftp://github.com/a/b", false},
		{"file", "", "github", "pat", "file:///etc/passwd", false},
		{"no scheme", "", "github", "pat", "attacker.example/a/b", false},
		{"ssh key anywhere", "", "generic", "ssh_key", "https://attacker.example/a/b", true},
		{"pat with scp-style url", "", "github", "pat", "git@attacker.example:a/b.git", true},
		{"pat with ssh url", "", "github", "pat", "ssh://git@attacker.example/a/b.git", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(AllowedOriginsEnv, tc.allowed)
			err := Check(tc.provider, tc.credType, tc.gitURL)
			if tc.wantOK && err != nil {
				t.Fatalf("expected allowed, got %v", err)
			}
			if !tc.wantOK && err == nil {
				t.Fatal("expected rejection, got nil")
			}
		})
	}
}

package main

import "testing"

func TestSafeReturnPath(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "/"},
		{"/dashboard", "/dashboard"},
		{"/dashboard?tab=logs", "/dashboard?tab=logs"},
		{"//evil.com", "/"},
		{"/\\evil.com", "/"},
		{"https://evil.com", "/"},
		{"http://evil.com", "/"},
		{"evil.com", "/"},
		{"/path\r\nInjected: header", "/"},
	}
	for _, c := range cases {
		if got := safeReturnPath(c.in); got != c.want {
			t.Errorf("safeReturnPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

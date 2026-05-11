package scanner

import "context"

// NoneProvider is used when scanning is disabled.
type NoneProvider struct{}

func (p *NoneProvider) HasScan() bool { return false }

func (p *NoneProvider) Scan(_ context.Context, _, _ string) (*ScanResult, error) {
	return &ScanResult{Status: "skipped"}, nil
}

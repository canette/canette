package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	ecrtypes "github.com/aws/aws-sdk-go-v2/service/ecr/types"
)

// ECRProvider triggers and polls ECR basic on-push scanning.
// No K8s Job is created — results come from the ECR API.
type ECRProvider struct {
	client       *ecr.Client
	mandatory    bool
	failSeverity string
}

func newECRProvider(cfg Config) (*ECRProvider, error) {
	region, err := parseECRRegion(cfg.ImageRepo)
	if err != nil {
		return nil, fmt.Errorf("parse ECR region for scanner: %w", err)
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(), awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load AWS config for ECR scanner: %w", err)
	}
	return &ECRProvider{
		client:       ecr.NewFromConfig(awsCfg),
		mandatory:    cfg.Mandatory,
		failSeverity: cfg.FailSeverity,
	}, nil
}

func (p *ECRProvider) HasScan() bool { return true }

// Scan triggers an ECR image scan and polls until complete (up to 10 min).
func (p *ECRProvider) Scan(ctx context.Context, _ string, imageRef string) (*ScanResult, error) {
	registryID, repoName, imageID, err := parseImageRef(imageRef)
	if err != nil {
		return &ScanResult{Status: "error"}, fmt.Errorf("parse image ref for ECR scan: %w", err)
	}

	// Trigger the scan explicitly (works even without ScanOnPush).
	_, err = p.client.StartImageScan(ctx, &ecr.StartImageScanInput{
		RegistryId:     aws.String(registryID),
		RepositoryName: aws.String(repoName),
		ImageId:        &imageID,
	})
	if err != nil {
		// SCAN_IN_PROGRESS means a scan is already running — treat as non-fatal.
		if !strings.Contains(err.Error(), "ScanAlreadyInProgress") && !strings.Contains(err.Error(), "LimitExceededException") {
			return &ScanResult{Status: "error"}, fmt.Errorf("start ECR scan: %w", err)
		}
	}

	// Poll until scan completes or context expires.
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return &ScanResult{Status: "error"}, ctx.Err()
		default:
		}

		out, err := p.client.DescribeImageScanFindings(ctx, &ecr.DescribeImageScanFindingsInput{
			RegistryId:     aws.String(registryID),
			RepositoryName: aws.String(repoName),
			ImageId:        &imageID,
		})
		if err != nil {
			return &ScanResult{Status: "error"}, fmt.Errorf("describe ECR scan findings: %w", err)
		}

		status := ""
		if out.ImageScanStatus != nil {
			status = string(out.ImageScanStatus.Status)
		}

		switch status {
		case string(ecrtypes.ScanStatusComplete):
			return p.buildResult(out.ImageScanFindings)
		case string(ecrtypes.ScanStatusFailed):
			return &ScanResult{Status: "error"}, fmt.Errorf("ECR scan failed: %s", safeStatusDesc(out.ImageScanStatus))
		}

		time.Sleep(5 * time.Second)
	}

	return &ScanResult{Status: "error"}, fmt.Errorf("ECR scan timed out after 10 minutes")
}

func (p *ECRProvider) buildResult(findings *ecrtypes.ImageScanFindings) (*ScanResult, error) {
	counts := map[string]int{
		"critical": 0, "high": 0, "medium": 0, "low": 0, "unknown": 0,
	}
	if findings != nil {
		for sev, count := range findings.FindingSeverityCounts {
			counts[strings.ToLower(sev)] = int(count)
		}
	}

	summaryJSON, err := json.Marshal(counts)
	if err != nil {
		return &ScanResult{Status: "error"}, fmt.Errorf("marshal scan summary: %w", err)
	}

	passed := p.scanPassed(counts)
	scanStatus := "pass"
	if !passed {
		scanStatus = "fail"
	}
	blocked := !passed && p.mandatory

	return &ScanResult{
		Status:  scanStatus,
		Summary: string(summaryJSON),
		Blocked: blocked,
		// SBOM: nil — ECR basic scanning does not produce a CycloneDX SBOM
	}, nil
}

func (p *ECRProvider) scanPassed(counts map[string]int) bool {
	order := []string{"critical", "high", "medium", "low"}
	threshold := strings.ToLower(p.failSeverity)
	for _, sev := range order {
		if counts[sev] > 0 {
			return false
		}
		if sev == threshold {
			break
		}
	}
	return true
}

// parseImageRef splits an ECR image ref into (registryID, repositoryName, imageIdentifier).
// Supports both digest (@sha256:...) and tag (:tag) forms.
// Example: "123456789012.dkr.ecr.us-east-1.amazonaws.com/canette/proj/app@sha256:abc"
func parseImageRef(imageRef string) (registryID, repoName string, imgID ecrtypes.ImageIdentifier, err error) {
	// Split off the host
	slashIdx := strings.Index(imageRef, "/")
	if slashIdx < 0 {
		return "", "", imgID, fmt.Errorf("invalid image ref (no /): %s", imageRef)
	}
	host := imageRef[:slashIdx]
	rest := imageRef[slashIdx+1:]

	// Extract 12-digit registry ID from host prefix
	re := regexp.MustCompile(`^(\d{12})\.dkr\.ecr\.`)
	m := re.FindStringSubmatch(host)
	if len(m) < 2 {
		return "", "", imgID, fmt.Errorf("cannot parse ECR registry ID from: %s", host)
	}
	registryID = m[1]

	// Split repository name from digest or tag
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		repoName = rest[:at]
		imgID.ImageDigest = aws.String(rest[at+1:])
	} else if colon := strings.LastIndex(rest, ":"); colon >= 0 {
		repoName = rest[:colon]
		imgID.ImageTag = aws.String(rest[colon+1:])
	} else {
		repoName = rest
	}

	if repoName == "" {
		return "", "", imgID, fmt.Errorf("empty repository name in image ref: %s", imageRef)
	}
	return registryID, repoName, imgID, nil
}

func parseECRRegion(imageRepo string) (string, error) {
	re := regexp.MustCompile(`\.ecr\.([a-z0-9-]+)\.amazonaws\.com`)
	m := re.FindStringSubmatch(imageRepo)
	if len(m) < 2 {
		return "", fmt.Errorf("cannot parse ECR region from: %s", imageRepo)
	}
	return m[1], nil
}

func safeStatusDesc(s *ecrtypes.ImageScanStatus) string {
	if s == nil {
		return "unknown"
	}
	if s.Description != nil {
		return *s.Description
	}
	return string(s.Status)
}

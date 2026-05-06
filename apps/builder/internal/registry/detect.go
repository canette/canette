package registry

import (
	"fmt"
	"regexp"
	"strings"
)

// DetectProvider auto-detects registry provider from IMAGE_REPO URL
func DetectProvider(imageRepo string) string {
	if strings.Contains(imageRepo, ".ecr.") && strings.Contains(imageRepo, ".amazonaws.com") {
		return "ecr"
	}
	if strings.Contains(imageRepo, "docker.io") || strings.Contains(imageRepo, "registry.hub.docker.com") {
		return "dockerhub"
	}
	if strings.Contains(imageRepo, "digitaloceanspaces.com") {
		return "digitalocean"
	}
	return "generic"
}

// ParseECRRegion extracts AWS region from ECR URL
// Example: "123456.dkr.ecr.us-east-1.amazonaws.com/canette/" → "us-east-1"
func ParseECRRegion(imageRepo string) (string, error) {
	re := regexp.MustCompile(`\.ecr\.([a-z0-9-]+)\.amazonaws\.com`)
	matches := re.FindStringSubmatch(imageRepo)
	if len(matches) < 2 {
		return "", fmt.Errorf("cannot parse ECR region from URL: %s", imageRepo)
	}
	return matches[1], nil
}

// ExtractRegistryURL extracts the base registry URL from IMAGE_REPO
// Example: "123456.dkr.ecr.us-east-1.amazonaws.com/canette/" → "123456.dkr.ecr.us-east-1.amazonaws.com"
func ExtractRegistryURL(imageRepo string) string {
	// Remove trailing slash and path
	trimmed := strings.TrimSuffix(imageRepo, "/")
	parts := strings.SplitN(trimmed, "/", 2)
	return parts[0]
}

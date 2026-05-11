package registry

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/ecr/types"
)

// ECRProvider handles Amazon ECR registry operations
type ECRProvider struct {
	client      *ecr.Client
	imageRepo   string // Full IMAGE_REPO (e.g., "123456.dkr.ecr.us-east-1.amazonaws.com/canette/")
	registryURL string // Just the host (e.g., "123456.dkr.ecr.us-east-1.amazonaws.com")
	pathPrefix  string // Extracted path prefix (e.g., "canette/")
	authType    string // "irsa" or "static"
}

// NewECRProvider creates a new ECR provider
func NewECRProvider(imageRepo, region, authType string) (*ECRProvider, error) {
	ctx := context.Background()

	// AWS SDK v2 automatically uses credential chain:
	// 1. IRSA (EKS ServiceAccount → IAM role)
	// 2. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
	// 3. Shared credentials file (~/.aws/credentials)
	awsCfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}

	client := ecr.NewFromConfig(awsCfg)
	registryURL := ExtractRegistryURL(imageRepo)

	// Extract path prefix from IMAGE_REPO
	// Example: "123456.dkr.ecr.us-east-1.amazonaws.com/canette/" → "canette/"
	pathPrefix := ""
	if strings.Contains(imageRepo, "/") {
		parts := strings.SplitN(imageRepo, "/", 2)
		if len(parts) > 1 {
			pathPrefix = parts[1]
		}
	}

	return &ECRProvider{
		client:      client,
		imageRepo:   imageRepo,
		registryURL: registryURL,
		pathPrefix:  pathPrefix,
		authType:    authType,
	}, nil
}

// EnsureRepository creates the ECR repository if it doesn't exist
func (p *ECRProvider) EnsureRepository(ctx context.Context, repoName string) error {
	// repoName: "project-slug/app-slug" (from builder)
	// ECR repository name: pathPrefix + repoName
	// Example: "canette/" + "my-project/my-app" → "canette/my-project/my-app"
	fullRepoName := strings.TrimSuffix(p.pathPrefix, "/") + "/" + repoName
	fullRepoName = strings.TrimPrefix(fullRepoName, "/")

	// Check if repository exists
	_, err := p.client.DescribeRepositories(ctx, &ecr.DescribeRepositoriesInput{
		RepositoryNames: []string{fullRepoName},
	})

	if err == nil {
		// Repository exists
		return nil
	}

	// Check if error is "repository not found"
	var notFoundErr *types.RepositoryNotFoundException
	if !errors.As(err, &notFoundErr) {
		// Some other error (permissions, network, etc.)
		return fmt.Errorf("describe ECR repository %s: %w", fullRepoName, err)
	}

	// Repository doesn't exist, create it
	_, err = p.client.CreateRepository(ctx, &ecr.CreateRepositoryInput{
		RepositoryName: aws.String(fullRepoName),
		ImageScanningConfiguration: &types.ImageScanningConfiguration{
			ScanOnPush: false, // canette triggers scans explicitly via StartImageScan
		},
		EncryptionConfiguration: &types.EncryptionConfiguration{
			EncryptionType: types.EncryptionTypeAes256, // Default ECR encryption
		},
	})

	if err != nil {
		return fmt.Errorf("create ECR repository %s: %w", fullRepoName, err)
	}

	return nil
}

// GetAuthConfig fetches a short-lived ECR token using the ambient IAM credentials
// (IRSA service account token, EC2 instance profile, or env-var credentials).
// The returned token is valid for 12 hours and is used to create a per-build
// docker config Secret that buildctl forwards to buildkitd on push.
func (p *ECRProvider) GetAuthConfig(ctx context.Context) (*AuthConfig, error) {
	if p.authType != "irsa" {
		// Static auth: credentials come from a pre-configured REGISTRY_AUTH_SECRET.
		return nil, nil
	}

	out, err := p.client.GetAuthorizationToken(ctx, &ecr.GetAuthorizationTokenInput{})
	if err != nil {
		return nil, fmt.Errorf("get ECR authorization token: %w", err)
	}
	if len(out.AuthorizationData) == 0 {
		return nil, fmt.Errorf("no ECR authorization data returned")
	}

	tokenBytes, err := base64.StdEncoding.DecodeString(aws.ToString(out.AuthorizationData[0].AuthorizationToken))
	if err != nil {
		return nil, fmt.Errorf("decode ECR authorization token: %w", err)
	}

	// ECR tokens are "AWS:<password>" encoded in base64.
	parts := strings.SplitN(string(tokenBytes), ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("unexpected ECR token format")
	}

	return &AuthConfig{Username: parts[0], Password: parts[1]}, nil
}

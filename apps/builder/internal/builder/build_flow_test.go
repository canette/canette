package builder

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	k8sjobs "canette.dev/builder/internal/k8s"
	"canette.dev/builder/internal/scanner"
	"canette.dev/builder/internal/store"
)

// fakeStore satisfies Storer for tests. ClaimPending returns a fixed set of
// deployments on the first call and nothing thereafter.
type fakeStore struct {
	deployments []store.PendingDeployment
	called      bool

	appendedLogs []string
	markedFailed []string
	markedDeploy []string
}

func (f *fakeStore) ClaimPending(_ context.Context, _ int) ([]store.PendingDeployment, error) {
	if f.called {
		return nil, nil
	}
	f.called = true
	return f.deployments, nil
}
func (f *fakeStore) AppendLog(_ context.Context, _ string, _ string, line string) error {
	f.appendedLogs = append(f.appendedLogs, line)
	return nil
}
func (f *fakeStore) MarkFailed(_ context.Context, id, _ string) error {
	f.markedFailed = append(f.markedFailed, id)
	return nil
}
func (f *fakeStore) GetGitCredential(_ context.Context, _ string) (*store.GitCredential, error) {
	return nil, nil
}
func (f *fakeStore) SetDeploymentCanetteConfig(_ context.Context, _, _ string) error { return nil }
func (f *fakeStore) UpdateCommitSha(_ context.Context, _, _ string) error             { return nil }
func (f *fakeStore) MarkScanning(_ context.Context, _, _ string) error                { return nil }
func (f *fakeStore) SetScanResults(_ context.Context, _, _, _, _ string) error        { return nil }
func (f *fakeStore) MarkDeploying(_ context.Context, id, _ string) error {
	f.markedDeploy = append(f.markedDeploy, id)
	return nil
}

func hasVolume(spec corev1.PodSpec, name string) bool {
	for _, v := range spec.Volumes {
		if v.Name == name {
			return true
		}
	}
	return false
}

// genericRepo is a plain registry URL — DetectProvider returns "generic" so
// no AWS calls are made during tests.
const genericRepo = "registry.example.com/canette/"

// pendingDep returns a minimal PendingDeployment with no git credentials.
func pendingDep(id string) store.PendingDeployment {
	return store.PendingDeployment{
		ID:          id,
		CommitSha:   "abc1234",
		AppID:       "app-1",
		AppSlug:     "myapp",
		ProjectSlug: "myproject",
		SourceType:  "git",
		GitURL:      "https://github.com/example/repo.git",
		GitBranch:   "main",
	}
}

// runBuildOnce triggers one processPending cycle on the builder and returns
// after all goroutines spawned by that cycle complete.
func runBuildOnce(t *testing.T, b *Builder) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.processPending(ctx); err != nil {
		t.Fatalf("processPending: %v", err)
	}
}

func newBuildFlowBuilder(t *testing.T, fs *fakeStore, k8s *fake.Clientset, authType string) *Builder {
	t.Helper()
	return New(
		fs,
		k8s,
		k8sjobs.BuildConfig{
			Namespace:        "canette-system",
			ImageRepo:        genericRepo,
			BuildkitdAddr:    "tcp://buildkitd:1234",
			BuilderImage:     "registry.example.com/canette-builder:latest",
			GitInitImage:     "registry.example.com/canette-git-init:latest",
			RegistryAuthType: authType,
		},
		nil,            // cryptoKey — not needed (no git credentials in these tests)
		zap.NewNop(),
		time.Second,
		1,
		scanner.Config{}, // NoneProvider
	)
}

// jobFromFake retrieves the single Job the builder created in the fake client.
func jobFromFake(t *testing.T, k8s *fake.Clientset) corev1.PodSpec {
	t.Helper()
	jobs, err := k8s.BatchV1().Jobs("canette-system").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list jobs: %v", err)
	}
	if len(jobs.Items) == 0 {
		t.Fatal("no Job was created in the fake k8s client")
	}
	return jobs.Items[0].Spec.Template.Spec
}

func TestBuildFlow_StaticAuth_NoServiceAccount(t *testing.T) {
	dep := pendingDep("d59d1c36-0000-0000-0000-000000000001")
	fs := &fakeStore{deployments: []store.PendingDeployment{dep}}
	k8s := fake.NewSimpleClientset()

	b := newBuildFlowBuilder(t, fs, k8s, "static")
	runBuildOnce(t, b)

	spec := jobFromFake(t, k8s)

	if spec.ServiceAccountName != "" {
		t.Errorf("ServiceAccountName = %q, want empty for static auth", spec.ServiceAccountName)
	}
	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Error("AutomountServiceAccountToken must be false for static auth")
	}
}

func TestBuildFlow_IRSAAuth_UsesServiceAccount(t *testing.T) {
	dep := pendingDep("d59d1c36-0000-0000-0000-000000000002")
	fs := &fakeStore{deployments: []store.PendingDeployment{dep}}
	k8s := fake.NewSimpleClientset()

	b := newBuildFlowBuilder(t, fs, k8s, "irsa")
	runBuildOnce(t, b)

	spec := jobFromFake(t, k8s)

	const wantSA = "canette-build-job"
	if spec.ServiceAccountName != wantSA {
		t.Errorf("ServiceAccountName = %q, want %q for IRSA", spec.ServiceAccountName, wantSA)
	}
	if spec.AutomountServiceAccountToken == nil || !*spec.AutomountServiceAccountToken {
		t.Error("AutomountServiceAccountToken must be true for IRSA")
	}
	if hasVolume(spec, "registry-auth") {
		t.Error("registry-auth volume must not be present when using IRSA")
	}
}

func TestBuildFlow_ECRRepo_AutoDetectsIRSA(t *testing.T) {
	dep := pendingDep("d59d1c36-0000-0000-0000-000000000003")
	dep.ProjectSlug = "myproject"
	dep.AppSlug = "myapp"
	fs := &fakeStore{deployments: []store.PendingDeployment{dep}}
	k8s := fake.NewSimpleClientset()

	// RegistryAuthType is empty — should auto-detect "irsa" from ECR URL.
	b := New(
		fs,
		k8s,
		k8sjobs.BuildConfig{
			Namespace:     "canette-system",
			ImageRepo:     "123456789012.dkr.ecr.us-east-1.amazonaws.com/canette/",
			BuildkitdAddr: "tcp://buildkitd:1234",
			BuilderImage:  "registry.example.com/canette-builder:latest",
			GitInitImage:  "registry.example.com/canette-git-init:latest",
			// RegistryAuthType intentionally omitted
		},
		nil,
		zap.NewNop(),
		time.Second,
		1,
		scanner.Config{},
	)

	// Resolved auth type must be "irsa" before any build happens.
	if b.cfg.RegistryAuthType != "irsa" {
		t.Fatalf("auto-detected RegistryAuthType = %q, want %q", b.cfg.RegistryAuthType, "irsa")
	}
	if b.registryConfig.AuthType != "irsa" {
		t.Fatalf("registryConfig.AuthType = %q, want %q", b.registryConfig.AuthType, "irsa")
	}
}

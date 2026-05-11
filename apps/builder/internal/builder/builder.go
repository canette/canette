// Package builder implements the poll loop and per-deployment build orchestration.
package builder

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"

	"canette.dev/builder/internal/crypto"
	"canette.dev/builder/internal/githubapp"
	k8sjobs "canette.dev/builder/internal/k8s"
	"canette.dev/builder/internal/registry"
	"canette.dev/builder/internal/scanner"
	"canette.dev/builder/internal/store"
)

func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// Builder polls the database for pending deployments and runs them as K8s Jobs.
// Storer is the subset of store.Store methods used by the builder.
type Storer interface {
	ClaimPending(ctx context.Context, limit int) ([]store.PendingDeployment, error)
	AppendLog(ctx context.Context, deploymentID, stream, line string) error
	MarkFailed(ctx context.Context, deploymentID, errMsg string) error
	GetGitCredential(ctx context.Context, id string) (*store.GitCredential, error)
	SetDeploymentCanetteConfig(ctx context.Context, deploymentID, yamlContent string) error
	UpdateCommitSha(ctx context.Context, deploymentID, sha string) error
	MarkScanning(ctx context.Context, deploymentID, scanJobName string) error
	SetScanResults(ctx context.Context, deploymentID, scanStatus, scanSummary, sbom string) error
	MarkDeploying(ctx context.Context, deploymentID, imageDigest string) error
}

type Builder struct {
	store          Storer
	k8s            kubernetes.Interface
	cfg            k8sjobs.BuildConfig
	cryptoKey      []byte
	log            *zap.Logger
	pollInterval   time.Duration
	maxConcurrent  int
	registryConfig registry.Config
	scanProvider   scanner.Provider
	scanProviderName  string // resolved provider name, used for MarkScanning job name
}

// New creates a Builder.
func New(
	s Storer,
	k kubernetes.Interface,
	cfg k8sjobs.BuildConfig,
	cryptoKey []byte,
	log *zap.Logger,
	pollInterval time.Duration,
	maxConcurrent int,
	scanCfg scanner.Config,
) *Builder {
	// Resolve registry auth type: explicit env var wins, otherwise detect from image repo URL.
	if cfg.RegistryAuthType == "" {
		if registry.DetectProvider(cfg.ImageRepo) == "ecr" {
			cfg.RegistryAuthType = "irsa"
		} else {
			cfg.RegistryAuthType = "static"
		}
	}

	scanProvider, providerName, err := scanner.NewProvider(scanCfg)
	if err != nil {
		log.Warn("failed to create scan provider, scanning disabled", zap.Error(err))
		scanProvider = &scanner.NoneProvider{}
		providerName = "none"
	}
	log.Info("scan provider ready", zap.String("provider", providerName))

	return &Builder{
		store:         s,
		k8s:           k,
		cfg:           cfg,
		cryptoKey:     cryptoKey,
		log:           log,
		pollInterval:  pollInterval,
		maxConcurrent: maxConcurrent,
		registryConfig: registry.Config{
			ImageRepo: cfg.ImageRepo,
			AuthType:  cfg.RegistryAuthType,
		},
		scanProvider:  scanProvider,
		scanProviderName: providerName,
	}
}

// Run starts the poll loop and blocks until ctx is cancelled.
func (b *Builder) Run(ctx context.Context) error {
	b.log.Info("builder started",
		zap.Duration("poll_interval", b.pollInterval),
		zap.Int("max_concurrent", b.maxConcurrent),
	)
	ticker := time.NewTicker(b.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			b.log.Info("builder shutting down")
			return nil
		case <-ticker.C:
			if err := b.processPending(ctx); err != nil {
				b.log.Error("poll cycle error", zap.Error(err))
			}
		}
	}
}

func (b *Builder) processPending(ctx context.Context) error {
	deps, err := b.store.ClaimPending(ctx, b.maxConcurrent)
	if err != nil {
		return fmt.Errorf("claim pending: %w", err)
	}
	if len(deps) == 0 {
		return nil
	}
	var wg sync.WaitGroup
	for _, dep := range deps {
		wg.Add(1)
		go func(d store.PendingDeployment) {
			defer wg.Done()
			b.build(ctx, d)
		}(dep)
	}
	wg.Wait()
	return nil
}

func (b *Builder) build(ctx context.Context, dep store.PendingDeployment) {
	log := b.log.With(
		zap.String("deployment", dep.ID),
		zap.String("app", dep.AppSlug),
		zap.String("commit", dep.CommitSha),
	)

	jobName := k8sjobs.JobName(dep.ID)

	// Ensure MarkFailed is called on any error path.
	var lastErr error
	defer func() {
		if lastErr != nil {
			log.Error("build failed", zap.Error(lastErr))
			_ = b.store.AppendLog(ctx, dep.ID, "stdout", "[canette] build failed: "+lastErr.Error())
			if err := b.store.MarkFailed(ctx, dep.ID, lastErr.Error()); err != nil {
				log.Error("failed to mark deployment failed", zap.Error(err))
			}
		}
	}()

	// 1. Deployment was claimed atomically by ClaimPending — proceed directly.
	log.Info("build started", zap.String("job", jobName))

	// 2. Resolve git credentials if the app has them.
	credType := "none"
	credSecretName := ""
	if dep.GitCredID != nil {
		cred, err := b.store.GetGitCredential(ctx, *dep.GitCredID)
		if err != nil {
			lastErr = fmt.Errorf("get credential: %w", err)
			return
		}
		if cred != nil {
			credSecretName = k8sjobs.CredSecretName(dep.ID)

			var secretCredType, secretCredValue string
			var secretKnownHosts *string

			switch cred.Type {
			case "github_app":
				// Use per-credential installation ID if set; otherwise fall back to env var (system credential).
				perCredInstallID := ""
				if cred.InstallationID != nil {
					perCredInstallID = *cred.InstallationID
				}
				token, tokenErr := githubapp.GenerateInstallationToken(ctx, perCredInstallID)
				if tokenErr != nil {
					lastErr = fmt.Errorf("generate GitHub App token: %w", tokenErr)
					return
				}
				secretCredType = "pat" // git-init uses x-access-token, same as PAT
				secretCredValue = token
			case "ssh_key":
				if cred.EncryptedValue == nil {
					lastErr = fmt.Errorf("ssh_key credential has no encrypted value")
					return
				}
				decrypted, decErr := crypto.Decrypt(*cred.EncryptedValue, b.cryptoKey)
				if decErr != nil {
					lastErr = fmt.Errorf("decrypt credential: %w", decErr)
					return
				}
				secretCredType = "ssh_key"
				secretCredValue = decrypted
				secretKnownHosts = cred.SSHKnownHosts
			default: // "pat"
				if cred.EncryptedValue == nil {
					lastErr = fmt.Errorf("pat credential has no encrypted value")
					return
				}
				decrypted, decErr := crypto.Decrypt(*cred.EncryptedValue, b.cryptoKey)
				if decErr != nil {
					lastErr = fmt.Errorf("decrypt credential: %w", decErr)
					return
				}
				secretCredType = "pat"
				secretCredValue = decrypted
			}

			credType = secretCredType
			if err := k8sjobs.CreateGitCredSecret(ctx, b.k8s,
				b.cfg.Namespace, credSecretName,
				secretCredType, secretCredValue, secretKnownHosts,
			); err != nil {
				lastErr = fmt.Errorf("create credential secret: %w", err)
				return
			}
			defer k8sjobs.DeleteSecret(ctx, b.k8s, b.cfg.Namespace, credSecretName)
		}
	}

	// 3. Ensure registry repository exists (auto-creation for ECR).
	repoName := dep.ProjectSlug + "/" + dep.AppSlug
	provider, err := registry.NewProvider(b.registryConfig)
	if err != nil {
		lastErr = fmt.Errorf("create registry provider: %w", err)
		return
	}
	if err := provider.EnsureRepository(ctx, repoName); err != nil {
		lastErr = fmt.Errorf("ensure registry repository: %w", err)
		return
	}
	log.Info("registry repository ready", zap.String("repo", repoName))

	// 3b. Fetch registry credentials for this build.
	// For IRSA/ECR, the builder daemon uses its own IAM role to get a short-lived
	// ECR token, writes it to a per-build Secret, and mounts it into the build job.
	// buildctl reads it and forwards the auth to buildkitd on push.
	// For static auth, an operator-managed Secret is referenced via cfg.RegistryAuthSecret.
	jobCfg := b.cfg
	auth, err := provider.GetAuthConfig(ctx)
	if err != nil {
		lastErr = fmt.Errorf("get registry auth: %w", err)
		return
	}
	if auth != nil {
		configJSON, err := registry.BuildDockerConfigJSON(b.registryConfig.ImageRepo, auth)
		if err != nil {
			lastErr = fmt.Errorf("build docker config: %w", err)
			return
		}
		regAuthSecretName := k8sjobs.RegistryAuthSecretName(dep.ID)
		if err := k8sjobs.CreateRegistryAuthSecret(ctx, b.k8s, b.cfg.Namespace, regAuthSecretName, configJSON); err != nil {
			lastErr = fmt.Errorf("create registry auth secret: %w", err)
			return
		}
		defer k8sjobs.DeleteSecret(ctx, b.k8s, b.cfg.Namespace, regAuthSecretName)
		jobCfg.RegistryAuthSecret = regAuthSecretName
	}

	// 4. Create the build Job.
	job := k8sjobs.BuildJob(
		dep.ID, dep.ProjectSlug, dep.AppSlug, dep.CommitSha,
		dep.GitURL, dep.GitBranch, dep.AppPath,
		credType, credSecretName,
		dep.CanetteConfig,
		jobCfg,
	)
	k8sjobs.LogJobManifest(log, job)
	if _, err := b.k8s.BatchV1().Jobs(b.cfg.Namespace).Create(ctx, job, metav1.CreateOptions{}); err != nil {
		lastErr = fmt.Errorf("create job: %w", err)
		return
	}
	log.Info("job created", zap.String("job", jobName))

	// 5. Wait for the pod to appear, then stream its logs.
	podName, err := b.waitForPod(ctx, log, jobName)
	if err != nil {
		lastErr = fmt.Errorf("wait for pod: %w", err)
		return
	}

	// Tail logs concurrently — errors here are informational only.
	// Structured marker lines are intercepted in memory and never written to build_logs.
	var capturedDigest, capturedImageRef, capturedCanetteConfigB64, capturedCommitSha string
	logDone := make(chan struct{})
	go func() {
		defer close(logDone)
		b.tailLogs(ctx, log, dep.ID, podName, []string{"git-clone", "image-build"}, map[string]*string{
			"CAN_IMAGE_DIGEST=":   &capturedDigest,
			"CAN_IMAGE_REF=":      &capturedImageRef,
			"CAN_CANETTE_CONFIG=": &capturedCanetteConfigB64,
			"CAN_COMMIT_SHA=":     &capturedCommitSha,
		})
	}()

	// 6. Watch the Job until it succeeds or fails.
	succeeded, err := b.watchJob(ctx, log, jobName)
	<-logDone // wait for log goroutine to finish before transitioning status
	if err != nil {
		lastErr = fmt.Errorf("watch job: %w", err)
		return
	}
	if !succeeded {
		lastErr = fmt.Errorf("build job failed (see build logs for details)")
		return
	}

	// 7. Store the repo's canette.yaml content if it was found during build.
	// This lets the controller use it at deploy time (repo config wins over UI config).
	if capturedCanetteConfigB64 != "" {
		decoded, decErr := base64Decode(capturedCanetteConfigB64)
		if decErr != nil {
			log.Warn("could not decode canette config from build logs", zap.Error(decErr))
		} else if err := b.store.SetDeploymentCanetteConfig(ctx, dep.ID, string(decoded)); err != nil {
			log.Warn("failed to store canette config", zap.Error(err))
		}
	}

	// 8. Update the deployment with the real commit SHA resolved by git-clone.
	if capturedCommitSha != "" {
		if err := b.store.UpdateCommitSha(ctx, dep.ID, capturedCommitSha); err != nil {
			log.Warn("failed to update commit sha", zap.Error(err))
		} else {
			log.Info("commit sha resolved", zap.String("sha", capturedCommitSha))
		}
	}

	// 9. Get the exact image ref and digest emitted by the build job — both intercepted in memory.
	imageRef := capturedImageRef
	if imageRef == "" {
		lastErr = fmt.Errorf("build succeeded but CAN_IMAGE_REF not found in build logs")
		return
	}
	digest := capturedDigest
	if digest == "" {
		lastErr = fmt.Errorf("build succeeded but CAN_IMAGE_DIGEST not found in build logs")
		return
	}
	log.Info("image pushed", zap.String("digest", digest), zap.String("ref", imageRef))

	// 10. Optionally run a security scan.
	if b.scanProvider.HasScan() {
		scanName := scanner.ScanName(dep.ID, b.scanProviderName)
		if err := b.store.MarkScanning(ctx, dep.ID, scanName); err != nil {
			lastErr = fmt.Errorf("mark scanning: %w", err)
			return
		}
		scanResult, scanErr := b.scanProvider.Scan(ctx, dep.ID, imageRef)
		if scanErr != nil {
			log.Warn("scan failed to run", zap.Error(scanErr))
			_ = b.store.AppendLog(ctx, dep.ID, "stdout", "[canette] scan error: "+scanErr.Error())
			_ = b.store.SetScanResults(ctx, dep.ID, "error", "", "")
		} else {
			_ = b.store.SetScanResults(ctx, dep.ID, scanResult.Status, scanResult.Summary, scanResult.SBOM)
			if scanResult.Blocked {
				lastErr = fmt.Errorf("scan blocked deployment: %s", scanResult.Summary)
				return
			}
			log.Info("scan complete", zap.String("status", scanResult.Status))
		}
	}

	// 11. Transition to deploying.
	if err := b.store.MarkDeploying(ctx, dep.ID, digest); err != nil {
		lastErr = fmt.Errorf("mark deploying: %w", err)
		return
	}
	log.Info("build complete, deployment queued for controller")
	lastErr = nil // success — suppress the deferred MarkFailed
}

// waitForPod polls until the pod for jobName has been assigned a name and
// scheduled (phase is not empty and not Unknown). This ensures the pod exists
// before we try to stream its logs.
func (b *Builder) waitForPod(ctx context.Context, log *zap.Logger, jobName string) (string, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		pods, err := b.k8s.CoreV1().Pods(b.cfg.Namespace).List(ctx, metav1.ListOptions{
			LabelSelector: labels.Set{"job-name": jobName}.String(),
		})
		if err != nil {
			return "", fmt.Errorf("list pods: %w", err)
		}
		for _, p := range pods.Items {
			if p.Name != "" && p.Status.Phase != "" && p.Status.Phase != corev1.PodUnknown {
				log.Debug("pod found", zap.String("pod", p.Name), zap.String("phase", string(p.Status.Phase)))
				return p.Name, nil
			}
		}
		time.Sleep(2 * time.Second)
	}
	return "", fmt.Errorf("pod for job %s did not appear within 2 minutes", jobName)
}

// maxBuildLogLines is the maximum number of lines stored per deployment.
// Lines beyond this limit are silently dropped (interceptor lines are still captured).
// This prevents a malicious or runaway build from flooding the build_logs table.
const maxBuildLogLines = 50_000

// tailLogs streams logs from the given containers sequentially.
// interceptors maps line prefixes (e.g. "CAN_IMAGE_DIGEST=") to destination pointers;
// matching lines are captured in memory and not written to the build log store.
func (b *Builder) tailLogs(ctx context.Context, log *zap.Logger, deploymentID, podName string, containers []string, interceptors map[string]*string) {
	var linesWritten int
	for _, container := range containers {
		if ctx.Err() != nil {
			return
		}
		log.Info("streaming container logs", zap.String("container", container), zap.String("pod", podName))
		if err := b.streamContainerLogs(ctx, log, deploymentID, podName, container, interceptors, &linesWritten); err != nil {
			log.Warn("log stream ended with error", zap.String("container", container), zap.Error(err))
		} else {
			log.Info("log stream finished", zap.String("container", container))
		}
	}
}

func (b *Builder) streamContainerLogs(ctx context.Context, log *zap.Logger, deploymentID, podName, container string, interceptors map[string]*string, linesWritten *int) error {
	// Retry opening the log stream — the container may not have started yet
	// even though the pod exists (especially for image-build after git-clone finishes).
	const maxAttempts = 15
	var stream interface{ Read([]byte) (int, error); Close() error }
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req := b.k8s.CoreV1().Pods(b.cfg.Namespace).GetLogs(podName, &corev1.PodLogOptions{
			Container: container,
			Follow:    true,
		})
		s, err := req.Stream(ctx)
		if err == nil {
			stream = s
			break
		}
		// Container not started yet — wait and retry
		if attempt == maxAttempts {
			return fmt.Errorf("open log stream for %s after %d attempts: %w", container, maxAttempts, err)
		}
		time.Sleep(3 * time.Second)
	}
	defer stream.Close()

	writeLine := func(line string) {
		for prefix, dest := range interceptors {
			if strings.HasPrefix(line, prefix) {
				*dest = strings.TrimPrefix(line, prefix)
				return
			}
		}
		if *linesWritten >= maxBuildLogLines {
			if *linesWritten == maxBuildLogLines {
				// Write exactly one warning as the final log entry.
				_ = b.store.AppendLog(ctx, deploymentID, "stdout",
					fmt.Sprintf("[canette] build log limit reached (%d lines) — further output suppressed", maxBuildLogLines))
				*linesWritten++
			}
			return
		}
		if werr := b.store.AppendLog(ctx, deploymentID, "stdout", line); werr != nil {
			log.Warn("failed to write build log line", zap.Error(werr))
		}
		*linesWritten++
	}

	buf := make([]byte, 4096)
	var partial strings.Builder
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			partial.Write(buf[:n])
			for {
				s := partial.String()
				idx := strings.IndexByte(s, '\n')
				if idx < 0 {
					break
				}
				line := s[:idx]
				partial.Reset()
				partial.WriteString(s[idx+1:])
				writeLine(line)
			}
		}
		if err != nil {
			if s := partial.String(); s != "" {
				writeLine(s)
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read log stream: %w", err)
		}
	}
}

// watchJob watches the Job until it terminates, returning true on success.
// If the watch channel closes before the job reaches a terminal state (transient
// apiserver restart or informer timeout), the watch is re-established from the
// last seen resourceVersion so no events are missed.
func (b *Builder) watchJob(ctx context.Context, log *zap.Logger, jobName string) (bool, error) {
	fieldSel := fields.OneTermEqualSelector("metadata.name", jobName).String()
	var resourceVersion string
	for {
		watcher, err := b.k8s.BatchV1().Jobs(b.cfg.Namespace).Watch(ctx, metav1.ListOptions{
			FieldSelector:   fieldSel,
			ResourceVersion: resourceVersion,
		})
		if err != nil {
			return false, fmt.Errorf("watch job: %w", err)
		}
		terminal, succeeded, rv, err := b.drainJobWatch(ctx, log, jobName, watcher)
		watcher.Stop()
		if rv != "" {
			resourceVersion = rv
		}
		if err != nil {
			return false, err
		}
		if terminal {
			return succeeded, nil
		}
		// Channel closed without a terminal event — transient (apiserver restart,
		// informer timeout). Re-establish from the last seen resourceVersion.
		log.Warn("job watch channel closed, re-establishing", zap.String("job", jobName))
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		default:
		}
	}
}

// drainJobWatch reads events from watcher until the job reaches a terminal state
// or the channel closes. Returns (terminal, succeeded, lastResourceVersion, error).
// terminal=false with nil error means the channel closed — caller should retry.
func (b *Builder) drainJobWatch(ctx context.Context, log *zap.Logger, jobName string, watcher watch.Interface) (terminal, succeeded bool, resourceVersion string, err error) {
	for {
		select {
		case <-ctx.Done():
			return false, false, resourceVersion, ctx.Err()
		case event, ok := <-watcher.ResultChan():
			if !ok {
				return false, false, resourceVersion, nil
			}
			if event.Type == watch.Error {
				return true, false, resourceVersion, fmt.Errorf("watch error event")
			}
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			if job.ResourceVersion != "" {
				resourceVersion = job.ResourceVersion
			}
			if job.Status.Succeeded > 0 {
				log.Info("job succeeded", zap.String("job", jobName))
				return true, true, resourceVersion, nil
			}
			for _, cond := range job.Status.Conditions {
				if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
					log.Warn("job failed", zap.String("job", jobName),
						zap.String("reason", cond.Reason), zap.String("message", cond.Message))
					return true, false, resourceVersion, nil
				}
			}
		}
	}
}

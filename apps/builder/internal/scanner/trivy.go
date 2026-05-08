package scanner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"go.uber.org/zap"
)

// TrivyProvider runs a Trivy K8s Job and streams its output to get scan results.
type TrivyProvider struct {
	k8s           kubernetes.Interface
	namespace     string
	trivyImage    string
	regAuthSecret string
	insecure      bool // true when scanning from an HTTP (non-TLS) registry
	mandatory     bool
	failSeverity  string
	logAppender   LogAppender
	log           *zap.Logger
}

func newTrivyProvider(cfg Config) *TrivyProvider {
	log := cfg.Log
	if log == nil {
		log = zap.NewNop()
	}
	// Auto-detect HTTP registries that need --insecure: in-cluster registry and localhost.
	insecure := strings.Contains(cfg.ImageRepo, ".svc.cluster.local") ||
		strings.HasPrefix(cfg.ImageRepo, "localhost") ||
		strings.HasPrefix(cfg.ImageRepo, "127.0.0.1")
	return &TrivyProvider{
		k8s:           cfg.K8sClient,
		namespace:     cfg.Namespace,
		trivyImage:    cfg.TrivyImage,
		regAuthSecret: cfg.RegAuthSecret,
		insecure:      insecure,
		mandatory:     cfg.Mandatory,
		failSeverity:  cfg.FailSeverity,
		logAppender:   cfg.LogAppender,
		log:           log,
	}
}

func (p *TrivyProvider) HasScan() bool { return true }

// Scan creates a Trivy K8s Job and waits for it to complete.
func (p *TrivyProvider) Scan(ctx context.Context, deploymentID, imageRef string) (*ScanResult, error) {
	log := p.log.With(zap.String("deployment", deploymentID))
	jobName := ScanName(deploymentID, "trivy")

	job := p.buildJob(deploymentID, imageRef, jobName)
	if _, err := p.k8s.BatchV1().Jobs(p.namespace).Create(ctx, job, metav1.CreateOptions{}); err != nil {
		return &ScanResult{Status: "error"}, fmt.Errorf("create trivy scan job: %w", err)
	}
	log.Info("trivy scan job created", zap.String("job", jobName))

	podName, err := p.waitForPod(ctx, log, jobName)
	if err != nil {
		return &ScanResult{Status: "error"}, fmt.Errorf("wait for trivy pod: %w", err)
	}

	var summary, sbomB64 string
	logDone := make(chan struct{})
	go func() {
		defer close(logDone)
		p.streamLogs(ctx, log, deploymentID, podName, &summary, &sbomB64)
	}()

	succeeded, err := p.watchJob(ctx, log, jobName)
	<-logDone
	if err != nil {
		return &ScanResult{Status: "error"}, fmt.Errorf("watch trivy job: %w", err)
	}
	if !succeeded {
		return &ScanResult{Status: "error"}, fmt.Errorf("trivy scan job failed")
	}

	sbom := decodeSBOM(sbomB64)
	passed := p.scanPassed(log, summary)
	status := "pass"
	if !passed {
		status = "fail"
	}
	if summary == "" {
		status = "error"
		passed = false
	}

	return &ScanResult{
		Status:  status,
		Summary: summary,
		SBOM:    sbom,
		Blocked: !passed && p.mandatory,
	}, nil
}

// scanScript is the Trivy container script — runs two passes (findings + SBOM)
// and emits structured CAN_SCAN_SUMMARY= and CAN_SCAN_SBOM= lines for the builder.
const scanScript = `set -eu
IMAGE_REF="${IMAGE_REF}"

echo "Scanning ${IMAGE_REF} ..."
trivy image \
  --format json \
  --output /results/findings.json \
  --exit-code 0 \
  "${IMAGE_REF}" || { echo "[canette] trivy scan step failed"; exit 1; }

echo "Generating SBOM ..."
trivy image \
  --format cyclonedx \
  --output /results/sbom.json \
  --scanners vuln \
  --exit-code 0 \
  "${IMAGE_REF}" || { echo "[canette] trivy sbom step failed"; exit 1; }

CRITICAL=$(awk 'BEGIN{c=0} /"Severity":"CRITICAL"/{c++} END{print c}' /results/findings.json)
HIGH=$(awk 'BEGIN{c=0} /"Severity":"HIGH"/{c++} END{print c}' /results/findings.json)
MEDIUM=$(awk 'BEGIN{c=0} /"Severity":"MEDIUM"/{c++} END{print c}' /results/findings.json)
LOW=$(awk 'BEGIN{c=0} /"Severity":"LOW"/{c++} END{print c}' /results/findings.json)
UNKNOWN=$(awk 'BEGIN{c=0} /"Severity":"UNKNOWN"/{c++} END{print c}' /results/findings.json)

echo "CAN_SCAN_SUMMARY={\"critical\":${CRITICAL},\"high\":${HIGH},\"medium\":${MEDIUM},\"low\":${LOW},\"unknown\":${UNKNOWN}}"
echo "Scan complete: critical=${CRITICAL} high=${HIGH} medium=${MEDIUM} low=${LOW} unknown=${UNKNOWN}"

SBOM_B64=$(base64 < /results/sbom.json | tr -d '\n')
echo "CAN_SCAN_SBOM=${SBOM_B64}"
`

func (p *TrivyProvider) buildEnv(imageRef string) []corev1.EnvVar {
	env := []corev1.EnvVar{{Name: "IMAGE_REF", Value: imageRef}}
	if p.insecure {
		env = append(env, corev1.EnvVar{Name: "TRIVY_INSECURE", Value: "true"})
	}
	return env
}

func (p *TrivyProvider) buildJob(deploymentID, imageRef, jobName string) *batchv1.Job {
	ttl := int32(600)
	backoff := int32(0)

	jobLabels := map[string]string{
		"app.kubernetes.io/managed-by": "canette",
		"canette.dev/component":        "builder",
		"canette.dev/deployment":       deploymentID,
	}

	volumeMounts := []corev1.VolumeMount{
		{Name: "results", MountPath: "/results"},
	}
	volumes := []corev1.Volume{
		{Name: "results", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
	}
	if p.regAuthSecret != "" {
		volumes = append(volumes, corev1.Volume{
			Name: "registry-auth",
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: p.regAuthSecret,
					Items:      []corev1.KeyToPath{{Key: ".dockerconfigjson", Path: "config.json"}},
				},
			},
		})
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name:      "registry-auth",
			MountPath: "/root/.docker",
			ReadOnly:  true,
		})
	}

	falseVal := false
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: p.namespace,
			Labels:    jobLabels,
			Annotations: map[string]string{
				"canette.dev/deployment-id": deploymentID,
			},
		},
		Spec: batchv1.JobSpec{
			TTLSecondsAfterFinished: &ttl,
			BackoffLimit:            &backoff,
			ActiveDeadlineSeconds:   ptrInt64(600),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: jobLabels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: &falseVal,
					SecurityContext: &corev1.PodSecurityContext{
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes: volumes,
					Containers: []corev1.Container{
						{
							Name:    "trivy",
							Image:   p.trivyImage,
							Command: []string{"sh", "-c", scanScript},
							Env:     p.buildEnv(imageRef),
							VolumeMounts: volumeMounts,
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("100m"),
									corev1.ResourceMemory: resource.MustParse("256Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("500m"),
									corev1.ResourceMemory: resource.MustParse("1Gi"),
								},
							},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: &falseVal,
							},
						},
					},
				},
			},
		},
	}
}

func (p *TrivyProvider) streamLogs(ctx context.Context, log *zap.Logger, deploymentID, podName string, summary, sbomB64 *string) {
	interceptors := map[string]*string{
		"CAN_SCAN_SUMMARY=": summary,
		"CAN_SCAN_SBOM=":    sbomB64,
	}
	if err := p.streamContainerLogs(ctx, log, deploymentID, podName, "trivy", interceptors); err != nil {
		log.Warn("scan log stream ended with error", zap.Error(err))
	}
}

func (p *TrivyProvider) streamContainerLogs(ctx context.Context, log *zap.Logger, deploymentID, podName, container string, interceptors map[string]*string) error {
	const maxAttempts = 15
	var stream interface {
		Read([]byte) (int, error)
		Close() error
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req := p.k8s.CoreV1().Pods(p.namespace).GetLogs(podName, &corev1.PodLogOptions{
			Container: container,
			Follow:    true,
		})
		s, err := req.Stream(ctx)
		if err == nil {
			stream = s
			break
		}
		if attempt == maxAttempts {
			return fmt.Errorf("open scan log stream after %d attempts: %w", maxAttempts, err)
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
		if p.logAppender != nil {
			_ = p.logAppender.AppendLog(ctx, deploymentID, "stdout", line)
		}
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
				writeLine(s[:idx])
				partial.Reset()
				partial.WriteString(s[idx+1:])
			}
		}
		if err != nil {
			if s := partial.String(); s != "" {
				writeLine(s)
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read scan log stream: %w", err)
		}
	}
}

func (p *TrivyProvider) waitForPod(ctx context.Context, log *zap.Logger, jobName string) (string, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}
		pods, err := p.k8s.CoreV1().Pods(p.namespace).List(ctx, metav1.ListOptions{
			LabelSelector: labels.Set{"job-name": jobName}.String(),
		})
		if err != nil {
			return "", fmt.Errorf("list pods: %w", err)
		}
		for _, pod := range pods.Items {
			if pod.Name != "" && pod.Status.Phase != "" && pod.Status.Phase != corev1.PodUnknown {
				log.Debug("scan pod found", zap.String("pod", pod.Name))
				return pod.Name, nil
			}
		}
		time.Sleep(2 * time.Second)
	}
	return "", fmt.Errorf("scan pod for job %s did not appear within 2 minutes", jobName)
}

func (p *TrivyProvider) watchJob(ctx context.Context, log *zap.Logger, jobName string) (bool, error) {
	fieldSel := fields.OneTermEqualSelector("metadata.name", jobName).String()
	var resourceVersion string
	for {
		watcher, err := p.k8s.BatchV1().Jobs(p.namespace).Watch(ctx, metav1.ListOptions{
			FieldSelector:   fieldSel,
			ResourceVersion: resourceVersion,
		})
		if err != nil {
			return false, fmt.Errorf("watch scan job: %w", err)
		}
		terminal, succeeded, rv, err := p.drainWatch(ctx, log, jobName, watcher)
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
		log.Warn("scan job watch closed, re-establishing", zap.String("job", jobName))
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		default:
		}
	}
}

func (p *TrivyProvider) drainWatch(ctx context.Context, log *zap.Logger, jobName string, watcher watch.Interface) (terminal, succeeded bool, resourceVersion string, err error) {
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
				log.Info("scan job succeeded", zap.String("job", jobName))
				return true, true, resourceVersion, nil
			}
			for _, cond := range job.Status.Conditions {
				if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
					log.Warn("scan job failed", zap.String("job", jobName))
					return true, false, resourceVersion, nil
				}
			}
		}
	}
}

func (p *TrivyProvider) scanPassed(log *zap.Logger, summaryJSON string) bool {
	if summaryJSON == "" {
		return false
	}
	var counts map[string]int
	if err := json.Unmarshal([]byte(summaryJSON), &counts); err != nil {
		log.Warn("could not parse scan summary", zap.Error(err))
		return false
	}
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

func decodeSBOM(b64 string) string {
	if b64 == "" {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	return string(data)
}

func ptrInt64(i int64) *int64 { return &i }

package health

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"

	"canette.dev/controller/internal/store"
	libk8s "canette.dev/lib/k8s"
)

const (
	// currentDeploymentRefresh is how often the watcher re-reads "which
	// deployment is current for each app" from the database. 30s of
	// staleness here is acceptable for a background signal — the
	// controller's own rollout check (CheckRollout) remains authoritative
	// for the deploy-in-progress window regardless.
	currentDeploymentRefresh = 30 * time.Second

	// resyncPeriod is a safety-net full replay of the informer's local
	// cache; the primary detection mechanism is the live event stream, not
	// this timer.
	resyncPeriod = 5 * time.Minute
)

// appKey identifies an app by the labels every canette-managed pod carries.
type appKey struct {
	projectID string
	appSlug   string
}

type liveDeployment struct {
	appID          string
	deploymentID   string
	deploymentType string // "web" | "private" | "cronjob"
}

// healthStore is the subset of *store.Store the watcher depends on, defined
// as an interface so tests can substitute a fake instead of a real database.
// *store.Store satisfies this structurally, no changes needed at call sites.
type healthStore interface {
	GetCurrentDeployments(ctx context.Context) ([]store.CurrentDeployment, error)
	UpdateRuntimeHealth(ctx context.Context, appID, health, reason string) error
}

// Watcher observes pod state changes cluster-wide via a Kubernetes informer
// (a single persistent watch connection, not polling) and maintains
// apps.runtime_health accordingly.
type Watcher struct {
	client kubernetes.Interface
	store  healthStore
	log    *zap.Logger

	mu          sync.Mutex
	current     map[appKey]liveDeployment
	podsByApp   map[appKey]map[types.UID]*corev1.Pod
	tracking    map[types.UID]*restartTracking
	noPodsSince map[appKey]time.Time
	lastWritten map[string]string // appID → "health|reason", debounces DB writes

	// refresh lets callers outside the watcher (the reconcile loop, right
	// after it marks a deployment live) ask for an immediate
	// refreshCurrentDeployments instead of waiting for the next
	// currentDeploymentRefresh tick. Buffered size 1 so a burst of triggers
	// coalesces into a single pending refresh and TriggerRefresh never
	// blocks its caller.
	refresh chan struct{}
}

// New creates a Watcher. Call Run to start it.
func New(client kubernetes.Interface, s *store.Store, log *zap.Logger) *Watcher {
	return &Watcher{
		client:      client,
		store:       s,
		log:         log,
		current:     make(map[appKey]liveDeployment),
		podsByApp:   make(map[appKey]map[types.UID]*corev1.Pod),
		tracking:    make(map[types.UID]*restartTracking),
		noPodsSince: make(map[appKey]time.Time),
		lastWritten: make(map[string]string),
		refresh:     make(chan struct{}, 1),
	}
}

// TriggerRefresh asks the watcher to re-read "which deployment is current
// for each app" as soon as Run's loop next runs, rather than waiting up to
// currentDeploymentRefresh. Safe to call from any goroutine; never blocks.
func (w *Watcher) TriggerRefresh() {
	select {
	case w.refresh <- struct{}{}:
	default:
	}
}

// Run blocks until ctx is cancelled. It watches all canette-managed pods
// cluster-wide and periodically refreshes which deployment is "current" for
// each app.
func (w *Watcher) Run(ctx context.Context) error {
	if err := w.refreshCurrentDeployments(ctx); err != nil {
		w.log.Warn("initial current-deployment refresh failed", zap.Error(err))
	}

	factory := informers.NewSharedInformerFactoryWithOptions(w.client, resyncPeriod,
		informers.WithTweakListOptions(func(o *metav1.ListOptions) {
			o.LabelSelector = libk8s.LabelManagedBy + "=" + libk8s.LabelManagedByVal
		}))
	podInformer := factory.Core().V1().Pods().Informer()
	_, err := podInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(obj interface{}) { w.onPodChanged(ctx, obj) },
		UpdateFunc: func(_, newObj interface{}) { w.onPodChanged(ctx, newObj) },
		DeleteFunc: func(obj interface{}) { w.onPodDeleted(ctx, obj) },
	})
	if err != nil {
		return fmt.Errorf("add pod event handler: %w", err)
	}

	factory.Start(ctx.Done())
	factory.WaitForCacheSync(ctx.Done())

	ticker := time.NewTicker(currentDeploymentRefresh)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := w.refreshCurrentDeployments(ctx); err != nil {
				w.log.Warn("current-deployment refresh failed", zap.Error(err))
			}
		case <-w.refresh:
			if err := w.refreshCurrentDeployments(ctx); err != nil {
				w.log.Warn("triggered current-deployment refresh failed", zap.Error(err))
			}
		}
	}
}

func (w *Watcher) refreshCurrentDeployments(ctx context.Context) error {
	deps, err := w.store.GetCurrentDeployments(ctx)
	if err != nil {
		return fmt.Errorf("get current deployments: %w", err)
	}

	next := make(map[appKey]liveDeployment, len(deps))
	for _, d := range deps {
		next[appKey{projectID: d.ProjectID, appSlug: d.AppSlug}] = liveDeployment{
			appID:          d.AppID,
			deploymentID:   d.DeploymentID,
			deploymentType: d.DeploymentType,
		}
	}

	w.mu.Lock()
	old := w.current
	w.current = next
	// Drop cached state for apps that are no longer live, so it doesn't
	// accumulate forever for stopped/deleted apps.
	for k, v := range old {
		if _, stillLive := next[k]; !stillLive {
			delete(w.podsByApp, k)
			delete(w.noPodsSince, k)
			delete(w.lastWritten, v.appID)
		}
	}
	w.mu.Unlock()

	// Re-evaluate every currently-known app: a redeploy may have changed
	// which deployment ID is current without any pod event firing in the
	// interim (e.g. the new pod was already observed before this refresh
	// caught up), so pods cached under a now-stale deployment ID need to be
	// re-filtered against the fresh mapping.
	w.mu.Lock()
	keys := make([]appKey, 0, len(next))
	for k := range next {
		keys = append(keys, k)
	}
	w.mu.Unlock()
	for _, k := range keys {
		w.evaluateApp(ctx, k)
	}
	return nil
}

func appKeyFromPod(pod *corev1.Pod) (appKey, bool) {
	projectID := pod.Labels[libk8s.LabelProjectID]
	appSlug := pod.Labels[libk8s.LabelApp]
	if projectID == "" || appSlug == "" {
		return appKey{}, false
	}
	return appKey{projectID: projectID, appSlug: appSlug}, true
}

func (w *Watcher) onPodChanged(ctx context.Context, obj interface{}) {
	pod, ok := obj.(*corev1.Pod)
	if !ok {
		return
	}
	key, ok := appKeyFromPod(pod)
	if !ok {
		return
	}
	w.mu.Lock()
	if w.podsByApp[key] == nil {
		w.podsByApp[key] = make(map[types.UID]*corev1.Pod)
	}
	w.podsByApp[key][pod.UID] = pod
	w.mu.Unlock()
	w.evaluateApp(ctx, key)
}

func (w *Watcher) onPodDeleted(ctx context.Context, obj interface{}) {
	pod, ok := obj.(*corev1.Pod)
	if !ok {
		tombstone, isTombstone := obj.(cache.DeletedFinalStateUnknown)
		if !isTombstone {
			return
		}
		pod, ok = tombstone.Obj.(*corev1.Pod)
		if !ok {
			return
		}
	}
	key, ok := appKeyFromPod(pod)
	if !ok {
		return
	}
	w.mu.Lock()
	delete(w.podsByApp[key], pod.UID)
	delete(w.tracking, pod.UID)
	w.mu.Unlock()
	w.evaluateApp(ctx, key)
}

// evaluateApp recomputes the aggregate runtime-health verdict for one app
// from its currently-tracked pods and writes it if it changed.
func (w *Watcher) evaluateApp(ctx context.Context, key appKey) {
	now := time.Now()

	w.mu.Lock()
	cur, ok := w.current[key]
	if !ok || cur.deploymentType == "cronjob" {
		// App isn't currently live, or has no long-running pod concept
		// (cronjob) — nothing for the watcher to say about it.
		w.mu.Unlock()
		return
	}

	var evals []podEvaluation
	havePods := false
	for uid, pod := range w.podsByApp[key] {
		if pod.Labels[libk8s.LabelDeployment] != cur.deploymentID {
			continue // stale pod from a superseded deployment, still terminating
		}
		havePods = true
		tr := w.tracking[uid]
		if tr == nil {
			tr = &restartTracking{}
			w.tracking[uid] = tr
		}
		tr.observe(pod, now)
		evals = append(evals, evaluatePod(pod, tr, now))
	}

	if havePods {
		delete(w.noPodsSince, key)
	} else if _, seen := w.noPodsSince[key]; !seen {
		w.noPodsSince[key] = now
	}

	healthVal, reason := aggregateAppHealth(evals, w.noPodsSince[key], now)
	verdict := healthVal + "|" + reason
	appID := cur.appID
	changed := w.lastWritten[appID] != verdict
	w.mu.Unlock()

	if !changed {
		return
	}
	if err := w.store.UpdateRuntimeHealth(ctx, appID, healthVal, reason); err != nil {
		w.log.Warn("update runtime health failed", zap.String("app_id", appID), zap.Error(err))
		return
	}
	w.mu.Lock()
	w.lastWritten[appID] = verdict
	w.mu.Unlock()
}

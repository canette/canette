// Package lifecycle holds live-cluster tests for Canette's deployment
// lifecycle: crashes, races and object reuse against a real controller,
// builder and API installed from the chart (issue #330).
//
// The tests carry the lifecycle build tag and need a release installed by the
// local e2e harness, which also runs them:
//
//	./scripts/e2e/macos-lima.sh --lifecycle
//
// See scripts/e2e/README.md.
package lifecycle

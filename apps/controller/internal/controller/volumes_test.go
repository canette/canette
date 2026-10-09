package controller

import (
	"testing"

	"canette.dev/controller/internal/store"
)

func TestResolveVolumeDeletion(t *testing.T) {
	t.Run("domain identifiers", func(t *testing.T) {
		ns, kind, name, err := resolveVolumeDeletion(store.PendingVolumeDeletion{
			ProjectID: "0123456789abcdef", ProjectSlug: "proj",
			AppSlug: "web", VolumeName: "nginx-conf", VolumeType: "configmap",
		})
		if err != nil {
			t.Fatal(err)
		}
		if ns != "can-01234567-proj" || kind != "ConfigMap" || name != "web-nginx-conf-cfg" {
			t.Errorf("got (%q, %q, %q)", ns, kind, name)
		}
	})

	t.Run("legacy row", func(t *testing.T) {
		ns, kind, name, err := resolveVolumeDeletion(store.PendingVolumeDeletion{
			LegacyNamespace: "can-x-proj", LegacyResourceType: "PersistentVolumeClaim", LegacyResourceName: "web-data",
		})
		if err != nil {
			t.Fatal(err)
		}
		if ns != "can-x-proj" || kind != "PersistentVolumeClaim" || name != "web-data" {
			t.Errorf("got (%q, %q, %q)", ns, kind, name)
		}
	})

	t.Run("emptyDir is rejected", func(t *testing.T) {
		if _, _, _, err := resolveVolumeDeletion(store.PendingVolumeDeletion{
			ProjectID: "p", ProjectSlug: "s", AppSlug: "a", VolumeName: "v", VolumeType: "emptyDir",
		}); err == nil {
			t.Error("expected error")
		}
	})
}

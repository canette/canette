package k8s

import "testing"

func TestVolumeResource(t *testing.T) {
	tests := []struct {
		volType  string
		wantKind string
		wantName string
		wantOK   bool
	}{
		{VolumeTypePVC, "PersistentVolumeClaim", "my-app-data", true},
		{VolumeTypeConfigMap, "ConfigMap", "my-app-data-cfg", true},
		{VolumeTypeEmptyDir, "", "", false},
		{"bogus", "", "", false},
	}
	for _, tt := range tests {
		kind, name, ok := VolumeResource("my-app", "data", tt.volType)
		if kind != tt.wantKind || name != tt.wantName || ok != tt.wantOK {
			t.Errorf("VolumeResource(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tt.volType, kind, name, ok, tt.wantKind, tt.wantName, tt.wantOK)
		}
	}
}

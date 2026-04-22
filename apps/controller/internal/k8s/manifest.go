// Package k8s renders applied resources as redacted YAML.
package k8s

import (
	"bytes"
	"fmt"

	sigsyaml "sigs.k8s.io/yaml"
)

// RenderManifest serialises res as YAML documents separated by "---".
// Secret data values are replaced with [REDACTED].
func RenderManifest(res AppResources) (string, error) {
	var buf bytes.Buffer

	objs := []map[string]interface{}{res.Namespace}
	if res.Secret != nil {
		objs = append(objs, redactSecret(res.Secret))
	}
	objs = append(objs, res.Deployment, res.Service, res.HTTPRoute)

	for _, obj := range objs {
		y, err := sigsyaml.Marshal(obj)
		if err != nil {
			return "", fmt.Errorf("marshal yaml: %w", err)
		}
		buf.WriteString("---\n")
		buf.Write(y)
	}
	return buf.String(), nil
}

// redactSecret returns a shallow copy of a Secret map with all data values replaced.
func redactSecret(obj map[string]interface{}) map[string]interface{} {
	out := shallowCopy(obj)
	if data, ok := obj["data"].(map[string]interface{}); ok {
		redacted := make(map[string]interface{}, len(data))
		for k := range data {
			redacted[k] = "REDACTED"
		}
		out["data"] = redacted
	}
	return out
}

func shallowCopy(m map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

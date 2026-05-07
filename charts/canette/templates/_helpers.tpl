{{/*
canette Helm chart helpers
*/}}

{{/* Fully qualified app name, truncated to 63 chars */}}
{{- define "canette.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels applied to all resources */}}
{{- define "canette.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/* Build namespace — always the system namespace with a -build suffix. */}}
{{- define "canette.buildNamespace" -}}
{{- printf "%s-build" .Release.Namespace }}
{{- end }}

{{/* Resolve the database URL.
     Uses in-cluster postgres when enabled, otherwise falls back to externalDatabase.url. */}}
{{- define "canette.databaseURL" -}}
{{- if .Values.postgres.enabled -}}
postgresql://canette:{{ .Values.postgres.password }}@postgres.{{ .Release.Namespace }}.svc.cluster.local:5432/canette?sslmode=disable
{{- else -}}
{{ required "externalDatabase.url is required when postgres.enabled=false" .Values.externalDatabase.url }}
{{- end -}}
{{- end }}

{{/* Resolve the image repo the builder pushes to.
     Uses in-cluster registry when enabled, otherwise requires builder.imageRepo. */}}
{{- define "canette.imageRepo" -}}
{{- if .Values.builder.imageRepo -}}
{{ .Values.builder.imageRepo }}
{{- else if .Values.registry.enabled -}}
registry.{{ .Release.Namespace }}.svc.cluster.local:5000/
{{- else -}}
{{ required "builder.imageRepo is required when registry.enabled=false" .Values.builder.imageRepo }}
{{- end -}}
{{- end }}

{{/* Resolve a canette service image.
     Args: list of (root, serviceName, override)
     Returns the override if non-empty, otherwise {image.repo}/{serviceName}:{image.tag} */}}
{{- define "canette.serviceImage" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $override := index . 2 -}}
{{- if $override -}}
{{ $override }}
{{- else -}}
{{- $tag := $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{ $root.Values.image.repo }}/{{ $name }}:{{ $tag }}
{{- end -}}
{{- end }}

{{/* imagePullPolicy: Always for mutable tags (:latest, :edge), IfNotPresent otherwise. */}}
{{- define "canette.imagePullPolicy" -}}
{{- if or (hasSuffix ":latest" .) (hasSuffix ":edge" .) -}}
Always
{{- else -}}
IfNotPresent
{{- end -}}
{{- end }}

{{/* Internal cluster URL the UI uses to reach the API (server-side rewrite). */}}
{{- define "canette.apiURL" -}}
http://canette-api.{{ .Release.Namespace }}.svc.cluster.local:3001
{{- end }}

{{/* Public URL of the UI — used as the CORS trusted origin in the API. */}}
{{- define "canette.uiURL" -}}
https://{{ required "ui.hostname is required" .Values.ui.hostname }}
{{- end }}

{{/* Resolve the registry host:port (no trailing slash or path segment).
     Used as the key in .dockerconfigjson for push credentials (build jobs). */}}
{{- define "canette.registryHost" -}}
{{- if .Values.registry.enabled -}}
registry.{{ .Release.Namespace }}.svc.cluster.local:5000
{{- else -}}
{{- .Values.builder.imageRepo | trimSuffix "/" | regexFind "^[^/]+" -}}
{{- end -}}
{{- end }}

{{/* Resolve the registry host:port as seen by the kubelet (pull hostname).
     For the in-cluster registry this is the external domain, not the internal service name.
     Used as the key in .dockerconfigjson for pull credentials (app imagePullSecrets). */}}
{{- define "canette.registryPullHost" -}}
{{- include "canette.pullRepo" . | trimSuffix "/" | regexFind "^[^/]+" -}}
{{- end }}

{{/* Name of the docker config Secret given to build jobs, or empty if no credentials. */}}
{{- define "canette.registryAuthSecretName" -}}
{{- if .Values.registry.enabled -}}
canette-registry-auth
{{- else if .Values.externalRegistry.username -}}
canette-registry-auth
{{- end -}}
{{- end }}

{{/* Internal cluster URL for the logstreamer service. */}}
{{- define "canette.logstreamerURL" -}}
http://canette-logstreamer.{{ .Release.Namespace }}.svc.cluster.local:8080
{{- end }}

{{/* Resolve the registry URL used by the kubelet to pull images.
     When registry.enabled=true and pullRepo is unset, derives registry.<domain>/.
     When registry.enabled=false, pullRepo must be set explicitly. */}}
{{- define "canette.pullRepo" -}}
{{- if .Values.controller.pullRepo -}}
{{ .Values.controller.pullRepo }}
{{- else if .Values.registry.enabled -}}
registry.{{ required "domain is required" .Values.domain }}/
{{- else -}}
{{- fail "controller.pullRepo is required when registry.enabled=false" -}}
{{- end -}}
{{- end }}

{{/* Resolve the buildkitd address.
     Defaults to the in-cluster buildkit service. */}}
{{- define "canette.buildkitdAddr" -}}
{{- if .Values.builder.buildkitdAddr -}}
{{ .Values.builder.buildkitdAddr }}
{{- else -}}
tcp://buildkitd.{{ include "canette.buildNamespace" . }}.svc.cluster.local:1234
{{- end -}}
{{- end }}

{{/* Resolve the buildkitd image.
     Uses buildkit.image when set; otherwise defaults to the rootless or standard
     moby/buildkit image based on buildkit.rootless. */}}
{{- define "canette.buildkitImage" -}}
{{- if .Values.buildkit.image -}}
{{ .Values.buildkit.image }}
{{- else if .Values.buildkit.rootless -}}
moby/buildkit:v0.21.0-rootless
{{- else -}}
moby/buildkit:v0.21.0
{{- end -}}
{{- end }}

{{/* Whether to enable imagePullSecrets in app Deployments.
     Defaults to true if not explicitly set. */}}
{{- define "canette.imagePullSecretsEnabled" -}}
{{- if hasKey .Values.controller "imagePullSecrets" -}}
{{- if hasKey .Values.controller.imagePullSecrets "enabled" -}}
{{ .Values.controller.imagePullSecrets.enabled }}
{{- else -}}
true
{{- end -}}
{{- else -}}
true
{{- end -}}
{{- end }}

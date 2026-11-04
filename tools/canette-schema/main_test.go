package main

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"canette.dev/lib/canetteyaml"
	"github.com/invopop/jsonschema"
)

// schemas returns the build and resources nodes of both generated schemas.
func schemas(t *testing.T) map[string]*jsonschema.Schema {
	t.Helper()
	r, err := newReflector("../../packages/golib")
	if err != nil {
		t.Fatal(err)
	}
	app := templateSchema(r).Properties.Value("apps").Items
	return map[string]*jsonschema.Schema{
		"canette.json":          canetteSchema(r),
		"canette-template.json": app,
	}
}

func matches(s *jsonschema.Schema, v string) bool {
	if s.MaxLength != nil && uint64(len(v)) > *s.MaxLength {
		return false
	}
	return s.Pattern == "" || regexp.MustCompile(s.Pattern).MatchString(v)
}

// The schema must accept and reject the same build values as
// BuildSpec.Validate, so a config that passes the schema never fails the build.
func TestBuildConstraintsMatchValidator(t *testing.T) {
	keys := []struct {
		key  string
		want bool
	}{
		{"NODE_ENV", true},
		{"_PRIVATE", true},
		{strings.Repeat("A", canetteyaml.MaxArgKeyLen), true},
		{"MY-ARG", false},
		{"1FOO", false},
		{"FOO=BAR", false},
		{"", false},
		{strings.Repeat("A", canetteyaml.MaxArgKeyLen+1), false},
	}
	values := []struct {
		value string
		want  bool
	}{
		{strings.Repeat("v", canetteyaml.MaxBuildValueLen), true},
		{strings.Repeat("v", canetteyaml.MaxBuildValueLen+1), false},
	}
	paths := []struct {
		path string
		want bool
	}{
		{"./src", true},
		{"docker/App.dockerfile", true},
		{"$(ls)", false},
		{"./app;rm -rf /", false},
		{".\nEVIL=1", false},
		{strings.Repeat("a", canetteyaml.MaxBuildValueLen+1), false},
	}

	for name, s := range schemas(t) {
		build := s.Properties.Value("build")
		args := build.Properties.Value("args")

		for _, tc := range keys {
			schemaOK := matches(args.PropertyNames, tc.key)
			validatorOK := canetteyaml.BuildSpec{Args: map[string]string{tc.key: "v"}}.Validate() == nil
			if schemaOK != tc.want || validatorOK != tc.want {
				t.Errorf("%s: args key %q: schema=%v validator=%v, want %v", name, tc.key, schemaOK, validatorOK, tc.want)
			}
		}

		str := args.AdditionalProperties.AnyOf[0]
		for _, tc := range values {
			schemaOK := matches(str, tc.value)
			validatorOK := canetteyaml.BuildSpec{Args: map[string]string{"KEY": tc.value}}.Validate() == nil
			if schemaOK != tc.want || validatorOK != tc.want {
				t.Errorf("%s: args value of length %d: schema=%v validator=%v, want %v", name, len(tc.value), schemaOK, validatorOK, tc.want)
			}
		}

		for _, n := range []int{canetteyaml.MaxArgCount, canetteyaml.MaxArgCount + 1} {
			many := make(map[string]string, n)
			for i := range n {
				many[fmt.Sprintf("ARG_%d", i)] = "v"
			}
			schemaOK := uint64(n) <= *args.MaxProperties
			validatorOK := canetteyaml.BuildSpec{Args: many}.Validate() == nil
			if schemaOK != validatorOK {
				t.Errorf("%s: %d args: schema=%v validator=%v", name, n, schemaOK, validatorOK)
			}
		}

		for _, field := range []string{"context", "dockerfile"} {
			p := build.Properties.Value(field)
			for _, tc := range paths {
				spec := canetteyaml.BuildSpec{Context: tc.path}
				if field == "dockerfile" {
					spec = canetteyaml.BuildSpec{Dockerfile: tc.path}
				}
				schemaOK := matches(p, tc.path)
				validatorOK := spec.Validate() == nil
				if schemaOK != tc.want || validatorOK != tc.want {
					t.Errorf("%s: build.%s %q: schema=%v validator=%v, want %v", name, field, tc.path, schemaOK, validatorOK, tc.want)
				}
			}
		}
	}
}

// cpu and memory accept bare numbers (YAML decodes them to strings) and
// strings in the Kubernetes quantity format.
func TestResourceQuantities(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"100m", true},
		{"1", true},
		{"0.5", true},
		{"128Mi", true},
		{"1Gi", true},
		{"1G", true},
		{"1e3", true},
		{"512MB", false},
		{"1GB", false},
		{"lots", false},
		{"", false},
	}
	for name, s := range schemas(t) {
		res := s.Properties.Value("resources")
		for _, kind := range []string{"requests", "limits"} {
			for _, field := range []string{"cpu", "memory"} {
				q := res.Properties.Value(kind).Properties.Value(field)
				if len(q.AnyOf) != 2 || q.AnyOf[0].Type != "string" || q.AnyOf[1].Type != "number" {
					t.Fatalf("%s: resources.%s.%s should accept a string or a number, got %+v", name, kind, field, q)
				}
				for _, tc := range cases {
					if got := matches(q.AnyOf[0], tc.value); got != tc.want {
						t.Errorf("%s: resources.%s.%s %q: schema=%v, want %v", name, kind, field, tc.value, got, tc.want)
					}
				}
			}
		}
	}
}

// `command: [sleep, 3600]` is valid: 3600 decodes to the string "3600".
func TestCommandAcceptsScalars(t *testing.T) {
	for name, s := range schemas(t) {
		items := s.Properties.Value("runtime").Properties.Value("command").Items
		types := []string{}
		for _, sub := range items.AnyOf {
			types = append(types, sub.Type)
		}
		if strings.Join(types, ",") != "string,number,boolean" {
			t.Errorf("%s: runtime.command items accept %v, want string, number and boolean", name, types)
		}
	}
}

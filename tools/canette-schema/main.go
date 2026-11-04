// canette-schema generates the JSON Schemas for canette.yaml and
// canette-template.yaml from the Go types in canette.dev/lib/canetteyaml, so the
// published schema can't drift from what the controller and builder parse.
//
// Run from the repo root with `bun run generate:schema`. CI regenerates the
// files and fails when they differ from the committed ones.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"canette.dev/lib/canetteyaml"
	"github.com/invopop/jsonschema"
)

const (
	schemaBaseURL = "https://canette.dev/schema/"
	draft07       = "http://json-schema.org/draft-07/schema#"
)

func main() {
	out := flag.String("out", "../../apps/docs/public/schema", "directory to write the schema files to")
	lib := flag.String("lib", "../../packages/golib", "path to the canette.dev/lib module, for doc comments")
	flag.Parse()

	if err := run(*out, *lib); err != nil {
		fmt.Fprintf(os.Stderr, "canette-schema: %v\n", err)
		os.Exit(1)
	}
}

func run(outDir, libDir string) error {
	outDir, err := filepath.Abs(outDir)
	if err != nil {
		return err
	}
	r, err := newReflector(libDir)
	if err != nil {
		return err
	}

	files := map[string]*jsonschema.Schema{
		"canette.json":          canetteSchema(r),
		"canette-template.json": templateSchema(r),
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	for name, s := range files {
		data, err := json.MarshalIndent(s, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal %s: %w", name, err)
		}
		if err := os.WriteFile(filepath.Join(outDir, name), append(data, '\n'), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func newReflector(libDir string) (*jsonschema.Reflector, error) {
	r := &jsonschema.Reflector{
		FieldNameTag:               "yaml",
		RequiredFromJSONSchemaTags: true,
		// Unknown fields are allowed (forward compatibility); finalize marks
		// every object with additionalProperties: true explicitly.
		AllowAdditionalProperties: true,
		// Inline every type: the schemas are small, and a self-contained field
		// is easier for an agent to read than a $ref.
		DoNotReference: true,
		Anonymous:      true,
	}

	// The template types live in this package ("main"); comment keys are the
	// import path joined with the directory walked, so walk ".".
	if err := r.AddGoComments("main", "."); err != nil {
		return nil, fmt.Errorf("read template doc comments: %w", err)
	}
	// Same for canetteyaml: walk "canetteyaml" from the lib module root so
	// the keys come out as canette.dev/lib/canetteyaml.<Type>.
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	if err := os.Chdir(libDir); err != nil {
		return nil, fmt.Errorf("open lib module: %w", err)
	}
	defer os.Chdir(cwd) //nolint:errcheck // best effort, the process exits right after
	if err := r.AddGoComments("canette.dev/lib", "canetteyaml"); err != nil {
		return nil, fmt.Errorf("read canetteyaml doc comments: %w", err)
	}
	return r, nil
}

func canetteSchema(r *jsonschema.Reflector) *jsonschema.Schema {
	s := r.Reflect(&canetteyaml.Config{})
	s.Title = "canette.yaml"
	s.Description = "Build and runtime configuration for a canette app, committed to the app's repository " +
		"or set as the app's canette config. All fields are optional: absence means \"use platform defaults\". " +
		"Unknown fields are ignored."
	return finalize(s, "canette.json")
}

func templateSchema(r *jsonschema.Reflector) *jsonschema.Schema {
	s := r.Reflect(&TemplateFile{})
	s.Title = "canette-template.yaml"
	s.Description = "A canette template: one or more apps created together in a project from a single file."

	// Each template app also accepts every canette.yaml field (anything that
	// isn't an app setting becomes that app's canette config). Fields the
	// template app defines itself (env, secrets) keep the template meaning.
	app := s.Properties.Value("apps").Items
	cfg := r.Reflect(&canetteyaml.Config{})
	for p := cfg.Properties.Oldest(); p != nil; p = p.Next() {
		if _, ok := app.Properties.Get(p.Key); !ok {
			app.Properties.Set(p.Key, p.Value)
		}
	}
	return finalize(s, "canette-template.json")
}

// finalize sets the schema's identity and normalizes the generated tree.
func finalize(s *jsonschema.Schema, file string) *jsonschema.Schema {
	s.Version = draft07
	s.ID = jsonschema.ID(schemaBaseURL + file)
	walk(s)
	return s
}

var spaces = regexp.MustCompile(`\s+`)

// walk applies, to every node:
//   - descriptions from multi-line Go comments collapsed to one line;
//   - additionalProperties: true on every object with known properties;
//   - string maps (env, build.args) accept any scalar value, since YAML
//     reads `PORT: 3000` as a number and canette stores it as a string.
func walk(s *jsonschema.Schema) {
	if s == nil {
		return
	}
	s.Description = strings.TrimSpace(spaces.ReplaceAllString(s.Description, " "))
	if s.Type == "object" && s.Properties != nil && s.AdditionalProperties == nil {
		s.AdditionalProperties = jsonschema.TrueSchema
	}
	if s.Type == "object" && s.Properties == nil && s.AdditionalProperties != nil && s.AdditionalProperties.Type == "string" {
		s.AdditionalProperties = scalar()
	}
	if s.Properties != nil {
		for p := s.Properties.Oldest(); p != nil; p = p.Next() {
			walk(p.Value)
		}
	}
	walk(s.Items)
	for _, sub := range s.OneOf {
		walk(sub)
	}
}

func scalar() *jsonschema.Schema {
	return &jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		{Type: "string"}, {Type: "number"}, {Type: "boolean"},
	}}
}

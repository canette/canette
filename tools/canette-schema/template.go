package main

import "github.com/invopop/jsonschema"

// The canette-template.yaml format. Templates are parsed by the API
// (apps/api/src/services/templates.ts), not by a Go service, so these types
// exist only to generate the schema. apps/api/tests/schema/schema.test.ts
// checks that these fields match the ones the API reads, in both directions.

// TemplateFile is a canette-template.yaml file.
type TemplateFile struct {
	// Template display name, shown in the template wizard.
	Name string `yaml:"name" jsonschema:"required"`
	// Optional subtitle shown under the name in the wizard.
	Description string `yaml:"description,omitempty"`
	// The apps to create, at least one. Each app is reviewed in the wizard
	// before anything is created.
	Apps []TemplateApp `yaml:"apps" jsonschema:"required,minItems=1"`
}

// TemplateApp is one app in a template. Besides the fields below, it accepts
// every canette.yaml field (runtime, resources, replicas, healthcheck,
// ingress, security, build); those are stored as the app's canette config.
type TemplateApp struct {
	// App display name.
	Name string `yaml:"name" jsonschema:"required"`
	// Suggested app slug, unique within the template: lowercase letters,
	// digits and hyphens, 1-63 characters, starting and ending with a letter
	// or digit. Other apps can reference it as {{apps.<slug>.slug}} in env
	// values.
	Slug string `yaml:"slug" jsonschema:"required,pattern=^[a-z0-9]([a-z0-9-]{0\\,61}[a-z0-9])?$"`
	// Where the app's image comes from: "git" builds the image from a Git
	// repository, "image" deploys an existing container image.
	SourceType string `yaml:"source_type,omitempty" jsonschema:"enum=git,enum=image,default=git"`
	// "web" gets a public URL, "private" is reachable only inside the
	// cluster, "cronjob" runs on a schedule and needs schedule.
	DeploymentType string `yaml:"deployment_type,omitempty" jsonschema:"enum=web,enum=private,enum=cronjob,default=web"`
	// Git repository URL, for source_type git.
	GitURL string `yaml:"git_url,omitempty" jsonschema:"example=https://github.com/org/repo"`
	// Branch to build, for source_type git. Defaults to "main".
	GitBranch string `yaml:"git_branch,omitempty" jsonschema:"default=main"`
	// ID of a canette Git credential for a private repository.
	GitCredentialID string `yaml:"git_credential_id,omitempty"`
	// Subdirectory of the repository that contains the app. Defaults to the
	// repository root.
	AppPath string `yaml:"app_path,omitempty"`
	// Container image to deploy, for source_type image, e.g. "nginx" or
	// "ghcr.io/org/app".
	ImageURL string `yaml:"image_url,omitempty" jsonschema:"example=nginx"`
	// Image tag, for source_type image. Defaults to "latest".
	ImageTag string `yaml:"image_tag,omitempty" jsonschema:"example=latest"`
	// Port the app listens on; canette sets PORT to this value. Not used for
	// deployment_type cronjob.
	Port int `yaml:"port,omitempty" jsonschema:"minimum=1,maximum=65535,example=3000"`
	// When a cronjob app runs, required for deployment_type cronjob: a
	// standard 5-field cron expression or @hourly, @daily, @weekly,
	// @monthly, @yearly or @midnight.
	Schedule string `yaml:"schedule,omitempty" jsonschema:"example=0 2 * * *"`
	// Plaintext environment variables, shown and editable in the wizard.
	// Values may reference other apps as {{apps.<slug>.slug}}. PORT is
	// reserved.
	Env map[string]string `yaml:"env,omitempty"`
	// Secrets the app needs. The wizard asks for their values, which are
	// never stored in the template.
	Secrets []TemplateSecret `yaml:"secrets,omitempty"`
}

// TemplateSecret is a secret name, or an object with a name and a
// description that guides whoever fills in the value.
type TemplateSecret struct {
	Name        string
	Description string
}

// JSONSchema describes the two accepted forms of a template secret.
func (TemplateSecret) JSONSchema() *jsonschema.Schema {
	props := jsonschema.NewProperties()
	props.Set("name", &jsonschema.Schema{Type: "string", Description: "Secret name, e.g. DATABASE_URL."})
	props.Set("description", &jsonschema.Schema{Type: "string", Description: "Shown in the wizard next to the value field."})
	return &jsonschema.Schema{
		Description: "A secret name, or an object with a name and a description that guides whoever fills in the value.",
		OneOf: []*jsonschema.Schema{
			{Type: "string", Description: "Secret name, e.g. DATABASE_URL."},
			{Type: "object", Properties: props, Required: []string{"name"}},
		},
	}
}

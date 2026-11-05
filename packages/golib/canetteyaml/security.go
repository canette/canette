package canetteyaml

import (
	"errors"

	"gopkg.in/yaml.v3"
)

// UnmarshalYAML decodes the security block field by field, so a wrong type
// gives a message naming the field (shown as the reason a deployment failed)
// instead of a raw yaml.v3 error. Unknown keys are ignored, and a null value
// counts as absent.
func (s *SecuritySpec) UnmarshalYAML(n *yaml.Node) error {
	n = resolve(n)
	if isNull(n) {
		return nil
	}
	if n.Kind != yaml.MappingNode {
		return errors.New("security must be a mapping of settings, for example `security: {hardened: true}`")
	}
	var raw struct {
		Hardened               yaml.Node `yaml:"hardened"`
		WritablePaths          yaml.Node `yaml:"writable_paths"`
		ReadOnlyRootFilesystem yaml.Node `yaml:"read_only_root_filesystem"`
		User                   yaml.Node `yaml:"user"`
	}
	if err := n.Decode(&raw); err != nil {
		return errors.New("security could not be read")
	}

	var out SecuritySpec
	if err := decodeField(&raw.Hardened, &out.Hardened, "", "security.hardened must be true or false"); err != nil {
		return err
	}
	if err := decodeField(&raw.ReadOnlyRootFilesystem, &out.ReadOnlyRootFilesystem, "", "security.read_only_root_filesystem must be true or false"); err != nil {
		return err
	}
	if err := decodeField(&raw.User, &out.User, "!!int", "security.user must be a whole number (a UID such as 10001)"); err != nil {
		return err
	}
	if wp := resolve(&raw.WritablePaths); !isNull(wp) {
		if wp.Kind != yaml.SequenceNode {
			return errors.New("security.writable_paths must be a list of paths, for example [\"/tmp\"]")
		}
		paths := make([]string, 0, len(wp.Content))
		for _, item := range wp.Content {
			item = resolve(item)
			if item.Kind != yaml.ScalarNode || isNull(item) {
				return errors.New("security.writable_paths must be a list of paths, for example [\"/tmp\"]")
			}
			paths = append(paths, item.Value)
		}
		// Non-nil even when empty: [] means "no writable paths", absent means
		// the default.
		out.WritablePaths = paths
	}
	*s = out
	return nil
}

// resolve follows YAML aliases (*name) to the node they refer to, so values
// reused through anchors are checked like values written in place.
func resolve(n *yaml.Node) *yaml.Node {
	for n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	return n
}

// isNull reports whether a node is absent (zero node) or an explicit null.
func isNull(n *yaml.Node) bool {
	return n.Kind == 0 || (n.Kind == yaml.ScalarNode && n.Tag == "!!null")
}

// decodeField decodes a scalar into *dst. wantTag, when set, is the YAML tag
// the value must resolve to: yaml.v3 would otherwise truncate 1.5 into an int.
func decodeField[T any](n *yaml.Node, dst **T, wantTag, msg string) error {
	n = resolve(n)
	if isNull(n) {
		return nil
	}
	var v T
	if n.Kind != yaml.ScalarNode || (wantTag != "" && n.ShortTag() != wantTag) || n.Decode(&v) != nil {
		return errors.New(msg)
	}
	*dst = &v
	return nil
}

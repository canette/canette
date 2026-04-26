// canette-config parses a canette.yaml and output a JSON object
// representing the golang Struct. This is only for manuial debugging of canette.yaml files.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"canette.dev/builder/internal/config"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: canette-config <path-to-canette.yaml>")
		os.Exit(1)
	}
	if err := run(os.Args[1], os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "canette-config: %v\n", err)
		os.Exit(1)
	}
}

func run(path string, w io.Writer) error {
	cfg, err := config.ParseFile(path)
	if err != nil {
		return err
	}

	result, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	fmt.Fprintf(w, "Parsed object:\n%s\n", string(result))
	return nil
}

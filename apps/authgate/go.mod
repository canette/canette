module canette.dev/authgate

go 1.26.0

require (
	canette.dev/lib v0.0.0
	github.com/joho/godotenv v1.5.1
	go.uber.org/zap v1.28.0
	golang.org/x/crypto v0.47.0
)

require go.uber.org/multierr v1.10.0 // indirect

replace canette.dev/lib => ../../packages/golib

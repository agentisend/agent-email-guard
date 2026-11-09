# Publishing the Go module

Written for launch day. Nothing here has been run. The orchestrating session runs it with the PHP release in
launch post 2, a week after Node and Python.

## Layout the tags depend on

The public repository `github.com/agentisend/agent-email-guard` holds this directory at `go/`, next to `spec/`:

```
agent-email-guard/
  spec/vectors/*.json
  go/                go.mod: module github.com/agentisend/agent-email-guard/go
  go/redisstore/     go.mod: module github.com/agentisend/agent-email-guard/go/redisstore
  go/pgstore/        go.mod: module github.com/agentisend/agent-email-guard/go/pgstore
  go/examples/       go.mod: not published, never tagged
```

A module in a sub-directory resolves only from a tag carrying that directory as a prefix, so the core is tagged
`go/v0.1.0`, not `v0.1.0`. The `replace ... => ../` lines in the sub-modules only apply when they are the main
module (local development); a consumer's build ignores them and uses the tagged core.

## 1. Pre-flight (in the public repo checkout)

```bash
cd go && go vet ./... && go test -race ./...
```

```bash
cd go/redisstore && go vet ./... && go test -race ./...
```

```bash
cd go/pgstore && go vet ./... && go test -race ./...
```

```bash
cd go/examples && go vet ./... && go test -race ./...
```

```bash
cd go && staticcheck ./... ./redisstore/... ./pgstore/...
```

`go test` in `go/` runs every file in `../spec/vectors`; confirm the output does not say `no vectors`. Optional,
against real servers: `AGENT_GUARD_REDIS_ADDR=localhost:6379` (flushes database 15) and
`AGENT_GUARD_PG_URL=postgres://...` (creates and drops `agent_email_guard_test_*` schemas).

Check `go/agentisend/version.go` says `0.1.0`.

## 2. Tag the core first

```bash
git tag -a go/v0.1.0 -m "agent-email-guard Go v0.1.0"
```

```bash
git push origin go/v0.1.0
```

## 3. Then the store modules

They require `github.com/agentisend/agent-email-guard/go v0.1.0`, which resolves only after step 2.

```bash
git tag -a go/redisstore/v0.1.0 -m "agent-email-guard Go redisstore v0.1.0" && git tag -a go/pgstore/v0.1.0 -m "agent-email-guard Go pgstore v0.1.0"
```

```bash
git push origin go/redisstore/v0.1.0 go/pgstore/v0.1.0
```

## 4. Make the proxy and pkg.go.dev fetch it

```bash
curl -s https://proxy.golang.org/github.com/agentisend/agent-email-guard/go/@v/v0.1.0.info
```

```bash
curl -s https://proxy.golang.org/github.com/agentisend/agent-email-guard/go/redisstore/@v/v0.1.0.info
```

```bash
curl -s https://proxy.golang.org/github.com/agentisend/agent-email-guard/go/pgstore/@v/v0.1.0.info
```

Each returns `{"Version":"v0.1.0",...}`. Then check a clean consumer resolves it:

```bash
cd "$(mktemp -d)" && go mod init probe && go get github.com/agentisend/agent-email-guard/go@v0.1.0 && go list -m all
```

pkg.go.dev picks the module up from the proxy within minutes. If
`https://pkg.go.dev/github.com/agentisend/agent-email-guard/go@v0.1.0` still shows "not found", press its
"Request github.com/agentisend/agent-email-guard/go@v0.1.0" button. Do the same for the two store modules. Each module
directory carries its own `LICENSE` (MIT), which pkg.go.dev needs to show the docs.

## 5. After

- The README's `go get` line works once step 4 passes.
- The AgentiSend Go SDK example imports `github.com/fortuneflick/agentisend-go`. If the SDK moves to the
  `agentisend` org, update `examples/go.mod` and `examples/agentisend/main.go`.
- Next release: bump `agentisend/version.go`, tag `go/v0.1.1` (and the store modules only if they changed; bump
  their `require` of the core when they need a newer one).
- A tag cannot be moved once the proxy has it. A broken release gets a new version and a `retract` line in
  `go/go.mod`.

# agent-email-guard check

A GitHub Action that warns when agent code sends email and that file does not import `agent-email-guard` and no `agent-email-guard.json` covers it. The default is a warning annotation. `fail: true` exits 1.

The action reads the files in the checkout. It does not install packages and it does not call the network.

[![agent-email-guard check](https://github.com/USER/REPO/actions/workflows/agent-email-guard.yml/badge.svg)](https://github.com/USER/REPO/actions/workflows/agent-email-guard.yml)

Save this as `.github/workflows/agent-email-guard.yml`. Replace `USER/REPO` in the badge with that repository. The badge is the workflow status on your repository.

```yaml
name: agent-email-guard
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v4 }, { uses: agentisend/agent-email-guard-action@v1 }]
```

To fail the job, add one step input:

```yaml
- uses: agentisend/agent-email-guard-action@v1
  with:
    fail: true
```

`scope: all` also flags send calls in files that do not import an agent SDK. The default `scope: agent` flags a file only when it imports `ai`, `@openai/agents`, `langchain`, `@modelcontextprotocol`, `mastra`, or `crewai` (including `@langchain/*`, `@mastra/*`, and `langchaingo`). An email MCP config is in scope either way.

## What a clean file looks like

Either of these clears a send:

- `agent-email-guard.json` in the same directory as the file, or in a parent directory, up to the scanned root. One file at the repository root covers the repository. The action checks that the file is present. `npx agent-email-guard validate` checks the shape.
- An import of `agent-email-guard`, `agent_email_guard`, `github.com/agentisend/agent-email-guard`, or `AgentiSend\AgentEmailGuard` in that file. A type-only import does not count. A guard import in a different file does not clear this one.

## What it flags

| Call | Rule |
|---|---|
| `resend.emails.send`, `resend.Emails.send`, `$resend->emails->send` | `resend.emails.send` |
| `sendMail(` | `nodemailer.sendMail` |
| `createTransport(` | `nodemailer.createTransport` |
| `SendEmail`, `SendEmailCommand` | `ses.SendEmail` |
| `SendRawEmail`, `SendRawEmailCommand` | `ses.SendRawEmail` |
| `.send_email(`, `.send_raw_email(` | `ses.send_email`, `ses.send_raw_email` |
| `sgMail.send` | `sendgrid.sgMail.send` |
| `.send(` in a file that imports SendGrid | `sendgrid.send` |
| `messages.create` in a file that imports or names Mailgun | `mailgun.messages.create` |
| `.sendEmail(` | `postmark.sendEmail` |
| `.emails.send`, not the Resend call above | `agentisend.emails.send` |
| An MCP config whose server name, command, args, or url names an email server | `mcp.email` |

MCP config files are `mcp.json`, `mcp.jsonc`, `.mcp.json`, and `claude_desktop_config.json`, plus any JSON object with `mcpServers`. A server named `email` counts. The word `email` inside an argument does not. `session` does not count as SES. Comments and string literals are not calls. `node_modules`, `dist`, `vendor`, and `coverage` are not scanned. A file over 1,000,000 bytes is skipped.

## Inputs

| Input | Default | Effect |
|---|---|---|
| `fail` | `false` | `true` exits 1 when any finding exists. |
| `scope` | `agent` | `all` flags send calls in non-agent files too. |
| `path` | `.` | Directory to scan, relative to `GITHUB_WORKSPACE`. |

The action writes at most 200 annotations. The log line states the full count.

## Publish

Listed on the GitHub Marketplace as [agent-email-guard check](https://github.com/marketplace/actions/agent-email-guard-check), from `github.com/agentisend/agent-email-guard-action` (tags `v1`, `v1.0.0`). Release steps: [PUBLISH.md](PUBLISH.md).

License: [LICENSE](LICENSE) (MIT).

# agent-email-safety

Blast-radius control for an agent that sends email: a daily cap, an hourly cap, no repeat loop, and no send over that line without a person. The skill teaches a coding agent to wrap the send with `agent-email-guard` before the provider is called.

The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent cannot bypass them, shared across processes and keys, with an approval queue and published thresholds.

It works with the send path you already have. Order: AgentiSend, nodemailer, SES, Resend, Postmark, SMTP.

## Install with the skills CLI

From the public repo `github.com/agentisend/agent-email-guard`:

```bash
npx skills add agentisend/agent-email-guard
```

The public repo root contains `skills/agent-email-safety/SKILL.md`, which is where the CLI looks. The `skills` CLI walks `skills/` up to three levels and treats `skills/<name>/SKILL.md` as a skill (vercel-labs/skills `docs/creating-skills.md`, checked 2026-11-09). A `SKILL.md` at the repo root shadows that directory, so the published repo must not have one.

Confirm discovery without installing:

```bash
npx skills add agentisend/agent-email-guard --list
```

Install one agent:

```bash
npx skills add agentisend/agent-email-guard --skill agent-email-safety -a claude-code
npx skills add agentisend/agent-email-guard --skill agent-email-safety -a cursor
npx skills add agentisend/agent-email-guard --skill agent-email-safety -a codex
```

Project paths the CLI writes (vercel-labs/skills `docs/agents.md`, checked 2026-11-09): Claude Code `.claude/skills/`, Cursor `.agents/skills/`, Codex `.agents/skills/`. Global paths: Claude Code `~/.claude/skills/`, Cursor `~/.cursor/skills/`, Codex `~/.agents/skills/`.

## Manual install

Copy the directory `agent-email-safety/` (the folder that contains `SKILL.md`) to the project path for the tool:

| Tool | Project path | Global path |
| --- | --- | --- |
| Claude Code | `.claude/skills/agent-email-safety/` | `~/.claude/skills/agent-email-safety/` |
| Cursor | `.agents/skills/agent-email-safety/` | `~/.cursor/skills/agent-email-safety/` |
| Codex | `.agents/skills/agent-email-safety/` | `~/.agents/skills/` |

Cursor also reads a project rule. Copy `cursor/agent-email-safety.mdc` to `.cursor/rules/agent-email-safety.mdc`. The frontmatter sets `alwaysApply: false` and a description, which is the "apply when relevant" rule type in Cursor's rules docs (checked 2026-11-09).

Paste `AGENTS.md.snippet` into the repo `AGENTS.md` (Codex and any other agent that reads that file). Paste `CLAUDE.md.snippet` into `CLAUDE.md`. Each file is 11 or 12 lines.

Codex has no third file format. It loads the same `SKILL.md` from `.agents/skills/` and loads repo instructions from `AGENTS.md` (OpenAI Codex skills docs and the skills CLI agent table, checked 2026-11-09). There is no `codex/` directory in this folder.

## Hook and MCP wrap

The skill tells the coding agent to run both of these. They are part of the `agent-email-guard` CLI (`hook` and `mcp` are forwarded subcommands):

```bash
npx agent-email-guard hook install
npx agent-email-guard mcp --wrap "<stdio command from that server's README>"
```

`hook install` writes a Claude Code PreToolUse hook into `.claude/settings.json`. The MCP wrap puts the same policy in front of an email MCP server you already run. Policy file for both: `agent-email-guard.json`.

`npx agent-email-guard test --demo` runs the red-team scenarios against a bundled agent; `npx agent-email-guard test ./my-agent.ts` runs them against yours.

## What this repo publishes

This directory is `skills/` inside the tree published as `github.com/agentisend/agent-email-guard`. In the AgentiSend monorepo that tree is `oss/agent-guard/` (the directory name stays). Do not point `npx skills add` at the monorepo: its root already has other skill directories, and this skill is not on a path the CLI walks from that root.

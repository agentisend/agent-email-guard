# agent-email-guard

Blast-radius control for agents that send email: at most N sends a day, M an hour, the fourth near-identical send in the window is refused, and no send that matches an approval rule until a person approves it.

This package is the Claude Code hook and the MCP proxy. The library is advisory. It runs in the agent's own process, so code the agent controls can remove it. AgentiSend enforces the same rules at the API, where the agent can't bypass them, shared across processes and keys, with an approval queue and published thresholds.

A hook or a proxy counts and holds sends. It does not scan a blocklist.

## Claude Code hook

`npx agent-email-guard hook install` writes a PreToolUse hook into the project's `.claude/settings.json`. `hook install --user` writes `~/.claude/settings.json` instead. `hook uninstall` and `hook status` use the same choice.

The installed command is exec form, no shell: `npx`, then `--yes`, `agent-email-guard-mcp@0.2`, `hook`, `run`. It does not write a path inside npm's `_npx` cache, works without a global install, and npx reuses its cache after the first call. `onFailure` is `block` (Claude Code v2.1.295 or later: a missing program, a crash, or a timeout blocks the tool call). The matcher is a JavaScript regular expression, which is how Claude Code treats a matcher that contains `.` or `*` ([hooks reference](https://code.claude.com/docs/en/hooks), fetched 2026-11-09):

```text
mcp__.*__.*(send|email|mail|Send|Email|Mail).*
```

That matches `mcp__resend__send-email`, `mcp__gmail__send_email`, `mcp__agentisend__send_batch`, and a plugin-scoped name like `mcp__plugin_my-plugin_db__send_email`. The script applies the same classification as the proxy, so `list_emails` is not counted and is not denied.

The script reads the tool-call JSON on stdin and `agent-email-guard.json` in the project (the hook's `cwd`). The store is a file, so the count survives the next process. On refuse or hold it exits 0 and prints one JSON object:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"… agent_budget_exceeded"}}
```

A hold uses the same deny and the reason starts with `approval required` plus the id. On allow it records the send, then prints `permissionDecision` `allow`. Stdout is only that JSON. Stderr is one JSON line per decision: outcome, reason, key, sha256 recipient hashes. No subject, no body, no address.

What that JSON means, from the same docs page, and only that:

- `deny` prevents the tool call. `permissionDecisionReason` is shown to Claude.
- `allow` skips the permission prompt, except for actions no mode auto-approves, reads from network paths, and tools an Agent SDK app marks `always_ask` unless the permission mode already approves the call. Deny rules and ask rules are still evaluated.
- Exit 0 is required for the JSON to be the decision. Exit 2 would also block, and would ignore an `allow`. This hook does not use exit 2.

This repo has not run Claude Code in `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions`. The hook does not read `permission_mode`. Do not treat it as tested in those modes. The model cannot skip the hook for a matched tool call in that session. It can still edit `.claude/settings.json` with a file tool, which removes the hook for the next session.

Approve a hold from the project directory: `npx agent-email-guard mcp approve <id>`. `npx agent-email-guard mcp approvals` lists ids and recipient hashes.

### Refused call, as a 60-second shot list

```text
0:00  Claude Code, project root, resend MCP already connected.
0:08  agent-email-guard.json on screen: {"version":1,"budgets":{"per_day":2}}
0:12  Terminal: npx agent-email-guard hook install
0:18  .claude/settings.json shows one PreToolUse hook, matcher mcp__.*__.*(send|email|mail|…).
0:24  The person asks: send three different receipts to a@example.com.
0:32  First tool call mcp__resend__send-email. Hook stdout is permissionDecision allow. The tool runs.
0:40  Second call, different body. allow. The tool runs.
0:48  Third call. Hook stdout is permissionDecision deny. The reason ends with agent_budget_exceeded.
0:55  Claude reads the reason. send-email did not run. stderr shows three JSON lines and no message body.
```

## Policy file

`agent-email-guard.json` in the working directory, read by the library's policy loader. Keys are the ones in SPEC §2.9 (`budgets.per_day`, `rate.per_minute`, `loop.mode`). Flags override the file. There is no daily ceiling until the file or `--per-day` sets one. Loop mode defaults to the library: `full`, and the 4th near-identical send inside the window is refused. One message counts as one send, including each item in a batch. Decisions are `createGuard` from `agent-email-guard` 0.1.0. The proxy's default store is memory; the hook always uses the file store in this package.

```json
{
  "version": 1,
  "budgets": { "per_day": 20, "per_hour": 10 },
  "rate": { "per_minute": 5 },
  "loop": { "mode": "full" },
  "approval": { "recipients": ["vip@example.com", "@new.example"] }
}
```

`pause` and `resume` write the library's kill-switch record into `.agent-email-guard/control.json`. A paused proxy or hook refuses with `kill_switch_active`. A control file that is not JSON is treated as paused.

## MCP proxy

`npx agent-email-guard mcp --wrap "<command>"` starts the upstream stdio server and speaks MCP on stdin and stdout. `--wrap-url <https url>` uses Streamable HTTP. Repeat `--header "Name: value"`. The value is copied through. `${VAR}` is replaced from the environment; the rest of the value is not rewritten.

`--send-tools send_email,send_batch` names the tools to check. With no list, a tool is checked when its name matches `send`, `email`, or `mail` and the arguments carry `to` plus a subject or a body (`text`, `html`, or `body`). A batch under `emails`, `messages`, or `batch` is one check per message. `allow` reserves, forwards, then `record`. An upstream error `release`s the reservation. `refuse` and `hold_for_approval` return `isError: true` and do not call upstream.

The key is `--key` or the upstream server name.

Commands below were checked on 2026-11-09.

- AgentiSend hosted MCP is `https://api.agentisend.com/mcp` with header `Authorization: Bearer <key>` (`plugins/agentisend/.mcp.json`). Send tools are `send_email` and `send_batch` (`packages/mcp/src/tools.ts`). The stdio package is `npx -y @agentisend/mcp-server` with `AGENTISEND_API_KEY`.
- `resend-mcp` stdio is `npx -y resend-mcp` with `RESEND_API_KEY` (README). Tool names `send-email` and `send-batch-emails` are `server.registerTool` in `src/tools/emails.ts` on `main`. The batch argument is `emails`.
- Gmail: `@gongrzhe/server-gmail-autoauth-mcp` README (1.1.11) uses `npx @gongrzhe/server-gmail-autoauth-mcp` after `npx @gongrzhe/server-gmail-autoauth-mcp auth`. The send tool in that README's client example is `send_email`, with `to`, `subject`, and `body`.

Placeholder keys below are not credentials.

### Claude Desktop

File: Claude Desktop settings, Developer, Edit Config (`claude_desktop_config.json`). Shape from the resend-mcp README.

AgentiSend:

```json
{
  "mcpServers": {
    "agentisend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap-url", "https://api.agentisend.com/mcp", "--header", "Authorization: Bearer ${AGENTISEND_API_KEY}", "--send-tools", "send_email,send_batch", "--per-day", "20"],
      "env": { "AGENTISEND_API_KEY": "as_your_key" }
    }
  }
}
```

Resend:

```json
{
  "mcpServers": {
    "resend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx -y resend-mcp", "--send-tools", "send-email,send-batch-emails", "--per-day", "20"],
      "env": { "RESEND_API_KEY": "re_your_key" }
    }
  }
}
```

Gmail:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx @gongrzhe/server-gmail-autoauth-mcp", "--send-tools", "send_email", "--per-day", "20"]
    }
  }
}
```

### Claude Code

`claude mcp add`, the same shape as the resend-mcp README. The hook above is the one to install first. These lines are the proxy, for a client that should see only the guarded server.

AgentiSend:

```bash
claude mcp add agentisend -e AGENTISEND_API_KEY=as_your_key -- npx -y agent-email-guard-mcp --wrap-url https://api.agentisend.com/mcp --header "Authorization: Bearer ${AGENTISEND_API_KEY}" --send-tools send_email,send_batch --per-day 20
```

Resend:

```bash
claude mcp add resend -e RESEND_API_KEY=re_your_key -- npx -y agent-email-guard-mcp --wrap "npx -y resend-mcp" --send-tools send-email,send-batch-emails --per-day 20
```

Gmail:

```bash
claude mcp add gmail -- npx -y agent-email-guard-mcp --wrap "npx @gongrzhe/server-gmail-autoauth-mcp" --send-tools send_email --per-day 20
```

### Cursor

`.cursor/mcp.json`. Command and args, from the resend-mcp README's Cursor block.

AgentiSend:

```json
{
  "mcpServers": {
    "agentisend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap-url", "https://api.agentisend.com/mcp", "--header", "Authorization: Bearer ${AGENTISEND_API_KEY}", "--send-tools", "send_email,send_batch", "--per-day", "20"],
      "env": { "AGENTISEND_API_KEY": "as_your_key" }
    }
  }
}
```

Resend:

```json
{
  "mcpServers": {
    "resend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx -y resend-mcp", "--send-tools", "send-email,send-batch-emails", "--per-day", "20"],
      "env": { "RESEND_API_KEY": "re_your_key" }
    }
  }
}
```

Gmail:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx @gongrzhe/server-gmail-autoauth-mcp", "--send-tools", "send_email", "--per-day", "20"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`. Stdio `command` / `args`, from the resend-mcp README's Windsurf stdio block. The console snippet for AgentiSend's hosted URL uses `serverUrl`; the guard is a local process, so Windsurf gets `command` and `args` instead.

AgentiSend:

```json
{
  "mcpServers": {
    "agentisend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap-url", "https://api.agentisend.com/mcp", "--header", "Authorization: Bearer ${AGENTISEND_API_KEY}", "--send-tools", "send_email,send_batch", "--per-day", "20"],
      "env": { "AGENTISEND_API_KEY": "as_your_key" }
    }
  }
}
```

Resend:

```json
{
  "mcpServers": {
    "resend": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx -y resend-mcp", "--send-tools", "send-email,send-batch-emails", "--per-day", "20"],
      "env": { "RESEND_API_KEY": "re_your_key" }
    }
  }
}
```

Gmail:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "agent-email-guard-mcp", "--wrap", "npx @gongrzhe/server-gmail-autoauth-mcp", "--send-tools", "send_email", "--per-day", "20"]
    }
  }
}
```

## 60 seconds, proxy, daily ceiling

```text
1. Write agent-email-guard.json with {"version":1,"budgets":{"per_day":2}}.
2. Point the client at one of the blocks above.
3. Ask for three receipts with different bodies, to a@example.com.
4. The first two tool results are the upstream's. The third is isError, and the text ends with agent_budget_exceeded.
5. The upstream send count is 2. stderr has three JSON lines and does not contain the body.
```

`pause` stops the next send until `resume`. Neither command sends mail.

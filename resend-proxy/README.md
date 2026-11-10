# Add spending limits to Resend in one environment variable

A local HTTP proxy that checks each send before it leaves the machine. This package is not affiliated with Resend.

The Resend SDK already reads `RESEND_BASE_URL`. Point that at the proxy. `POST /emails` and `POST /emails/batch` are checked, one message at a time, against `agent-email-guard.json`. A request that is allowed is forwarded unchanged to the upstream (default `https://api.resend.com`). The message bytes are not rewritten. The `Authorization` header is copied through and is not logged. Neither is the body.

The proxy counts and holds sends. It does not scan a blocklist.

```bash
npx agent-email-guard-proxy
```

```bash
RESEND_BASE_URL=http://localhost:8787
```

The proxy listens on `127.0.0.1:8787`. The same variable is how a Resend SDK reaches the proxy; the proxy's own upstream is a different setting.

## Policy and store

`agent-email-guard.json` in the working directory, the file the `agent-email-guard` library reads. There is no daily cap until the file sets one.

```json
{
  "version": 1,
  "budgets": { "per_day": 20, "per_hour": 10 },
  "rate": { "per_minute": 5 },
  "loop": { "mode": "full" }
}
```

Counts live in `.agent-email-guard/store.json`, so a restart does not reset the day. A batch counts one send per message. If any message in the batch is refused or held, the proxy forwards nothing and gives back the reservations it had taken.

## What a refusal looks like

The body is Resend's error object. `name` is the guard's reason token. `message` is the guard's sentence. `statusCode` is `429` for a spent budget or a per-minute ceiling, and `403` for a hold, a kill switch, a suppression or a loop.

```json
{
  "name": "agent_budget_exceeded",
  "message": "Key \"default\" has used its daily budget of 20 emails; it resets at 2026-11-11T00:00:00Z.",
  "statusCode": 429
}
```

An upstream error is returned as the upstream sent it, and the reservation is released, so a rejected send does not consume the cap.

## Upstream

`AGENT_EMAIL_GUARD_UPSTREAM` (or `--upstream`) is where an allowed request goes. The default is `https://api.resend.com`. Set it to `https://api.agentisend.com` to send the same checked requests to AgentiSend. The client still uses `RESEND_BASE_URL` for the proxy.

```bash
agent-email-guard-proxy --port 8787 --upstream https://api.resend.com --policy ./agent-email-guard.json --store ./.agent-email-guard/store.json
```

Other paths (`GET /emails`, domains, webhooks) are forwarded without a check.

A hold returns `403` and does not send. This proxy has no approve route: take the address out of the policy, or turn that check off, and send again.

## License

MIT. Copyright AgentiSend.

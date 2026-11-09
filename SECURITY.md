# Security

## Reporting

Email **hello@agentisend.com** with "agent-email-guard security" in the subject. Please include the version, the language, and steps or a vector that reproduces the problem. We reply within 3 working days and will tell you when a fix ships. Please do not open a public issue for a vulnerability before then.

## What counts

- A sequence of calls that lets more sends through than a configured budget or rate ceiling (an atomicity bug in a store).
- A send that passes while the kill switch is paused.
- A way for one key's state to read or change another key's in a shared store.
- Injection through a key name, address or table prefix into Redis or SQL.

## What does not

agent-email-guard is advisory by design: it runs in the agent's own process, so code with access to that process can remove or bypass it. That is documented behaviour, not a vulnerability. If you need limits an agent cannot remove, enforce them server-side (for example with AgentiSend's API-key limits).

## Supported versions

The latest minor release of each package.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { stubTransport } from "../../adapter/stub-transport.ts";
import { testGuard } from "../../adapter/test-guard.ts";
import { executeGuardedEmail, guardedEmailTool } from "../src/index.ts";

const require = createRequire(import.meta.url);
const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };
const toolOptions = { toolCallId: "call-1", messages: [] as [] };

test("the targeted ai package is 7.0.166", () => {
  assert.equal(require("ai/package.json").version, "7.0.166");
});

test("an allow sends once; the next send over the daily budget is the tool result and does not send", async () => {
  const guard = testGuard({ budgets: { perDay: 1 } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send, key: "agent-1" });
  assert.equal(typeof emailTool.execute, "function");
  assert.equal(await emailTool.execute!(input, toolOptions), "Sent stub-1");
  const text = await emailTool.execute!({ ...input, text: "Second receipt." }, toolOptions);
  assert.match(text, /^Key "agent-1" has used its daily budget of 1 email; .*\[agent_budget_exceeded\]$/);
  assert.equal(transport.sent.length, 1);
});

test("a hold is tool result text and does not send", async () => {
  const guard = testGuard({ approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const text = await executeGuardedEmail({ guard, send: transport.send }, input);
  assert.match(text, /^Approval required\. .*\[recipient_requires_approval\]$/);
  assert.equal(transport.sent.length, 0);
});

test("a transport failure releases the budget, so the next send goes out", async () => {
  const guard = testGuard({ budgets: { perDay: 1 } });
  const transport = stubTransport();
  transport.failNext();
  await assert.rejects(
    () => executeGuardedEmail({ guard, send: transport.send }, input),
    /stub transport refused/,
  );
  assert.equal(await executeGuardedEmail({ guard, send: transport.send }, input), "Sent stub-1");
});

test("the README states blast-radius control and does not claim prompt-injection blocking", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /blast-radius control/);
  assert.doesNotMatch(readme, /prompt injection/i);
  assert.doesNotMatch(readme, /AI guardrails/i);
  assert.match(readme, /7\.0\.166/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { stubTransport } from "../../adapter/stub-transport.ts";
import { testGuard } from "../../adapter/test-guard.ts";
import { executeGuardedEmail, guardedEmailTool } from "../src/index.ts";

const require = createRequire(import.meta.url);
const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };

test("the targeted Mastra package is 1.82.0", () => {
  assert.equal(require("@mastra/core/package.json").version, "1.82.0");
});

test("a send over the daily budget is the tool result and does not send", async () => {
  const guard = testGuard({ budgets: { perDay: 1 } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send, key: "agent-1" });
  assert.equal(emailTool.id, "send_email");
  assert.equal(await emailTool.execute!(input, {}), "Sent stub-1");
  const text = await emailTool.execute!({ ...input, text: "Second receipt." }, {});
  assert.match(String(text), /^Key "agent-1" has used its daily budget of 1 email; .*\[agent_budget_exceeded\]$/);
  assert.equal(transport.sent.length, 1);
});

test("hold_for_approval calls agent.suspend and does not send", async () => {
  const guard = testGuard({ approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const suspended: { reason: string; message: string }[] = [];
  const text = await executeGuardedEmail({ guard, send: transport.send }, input, {
    agent: {
      suspend(payload) {
        suspended.push(payload);
        return payload;
      },
    },
  });
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0]?.reason, "recipient_requires_approval");
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(text, suspended[0]);
});

test("resumeData.approved sends, and the send is recorded against the budget", async () => {
  const guard = testGuard({ budgets: { perDay: 1 }, approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const options = { guard, send: transport.send };
  const approved = { agent: { resumeData: { approved: true } } };
  assert.equal(await executeGuardedEmail(options, input, approved), "Sent stub-1");
  const second = await executeGuardedEmail(options, { ...input, text: "Second receipt." }, approved);
  assert.match(String(second), /\[agent_budget_exceeded\]$/);
  assert.equal(transport.sent.length, 1);
});

test("a declined resume does not send", async () => {
  const transport = stubTransport();
  const text = await executeGuardedEmail({ guard: testGuard(), send: transport.send }, input, {
    agent: { resumeData: { approved: false } },
  });
  assert.equal(text, "Approval required. The send was not approved.");
  assert.equal(transport.sent.length, 0);
});

test("the README states blast-radius control and does not claim prompt-injection blocking", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /blast-radius control/);
  assert.doesNotMatch(readme, /prompt injection/i);
  assert.doesNotMatch(readme, /AI guardrails/i);
  assert.match(readme, /1\.82\.0/);
});

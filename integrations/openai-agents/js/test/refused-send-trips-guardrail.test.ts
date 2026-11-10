import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stubTransport } from "../../../adapter/stub-transport.ts";
import { testGuard } from "../../../adapter/test-guard.ts";
import { applyEmailGuardrail, guardedEmailTool } from "../src/index.ts";

const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };

test("the targeted @openai/agents package is 0.21.0", () => {
  const pkg = new URL("../../../node_modules/@openai/agents/package.json", import.meta.url);
  assert.equal(JSON.parse(readFileSync(pkg, "utf8")).version, "0.21.0");
});

test("the guardrail is the one agent-email-guard ships", () => {
  const emailTool = guardedEmailTool({ guard: testGuard(), send: stubTransport().send });
  assert.equal(emailTool.inputGuardrails?.[0]?.name, "agent-email-guard");
  assert.equal(emailTool.inputGuardrails?.[0]?.type, "tool_input");
});

test("an allow runs the tool; a send over the daily budget trips the guardrail and does not send", async () => {
  const guard = testGuard({ budgets: { perDay: 1 } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send, key: "agent-1" });

  assert.equal(await applyEmailGuardrail(emailTool, input), "Sent stub-1");
  const text = await applyEmailGuardrail(emailTool, { ...input, text: "Second receipt." });

  assert.match(text, /^refuse \(agent_budget_exceeded\): Key "agent-1" has used its daily budget of 1 email;/);
  assert.equal(transport.sent.length, 1);
});

test("a hold comes back as a guardrail rejection and does not send", async () => {
  const guard = testGuard({ approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const text = await applyEmailGuardrail(guardedEmailTool({ guard, send: transport.send }), input);
  assert.match(text, /^hold_for_approval \(recipient_requires_approval\): /);
  assert.equal(transport.sent.length, 0);
});

test("the fourth near-identical send is refused as a loop", async () => {
  const guard = testGuard();
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send });
  for (let i = 0; i < 3; i += 1) assert.equal(await applyEmailGuardrail(emailTool, input), `Sent stub-${i + 1}`);
  assert.match(await applyEmailGuardrail(emailTool, input), /^refuse \(loop_repetition_detected\)/);
  assert.equal(transport.sent.length, 3);
});

test("a transport failure reaches the caller", async () => {
  const transport = stubTransport();
  transport.failNext();
  await assert.rejects(
    () => applyEmailGuardrail(guardedEmailTool({ guard: testGuard(), send: transport.send }), input),
    /stub transport refused/,
  );
});

test("the README states blast-radius control and does not claim prompt-injection blocking", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /blast-radius control/);
  assert.doesNotMatch(readme, /prompt injection/i);
  assert.doesNotMatch(readme, /AI guardrails/i);
  assert.match(readme, /0\.21\.0/);
});

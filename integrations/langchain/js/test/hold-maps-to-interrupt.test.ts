import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { stubTransport } from "../../../adapter/stub-transport.ts";
import { testGuard } from "../../../adapter/test-guard.ts";
import { guardedEmailTool } from "../src/index.ts";

const require = createRequire(import.meta.url);
const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };

test("the targeted LangChain packages match the README", () => {
  assert.equal(require("@langchain/core/package.json").version, "1.3.5");
  assert.equal(require("@langchain/langgraph/package.json").version, "1.7.2");
  assert.equal(require("langchain/package.json").version, "1.6.3");
});

test("a send over the daily budget is tool text and does not send", async () => {
  const guard = testGuard({ budgets: { perDay: 1 } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send, key: "agent-1" });
  assert.equal(await emailTool.invoke(input), "Sent stub-1");
  const text = await emailTool.invoke({ ...input, text: "Second receipt." });
  assert.match(String(text), /^Key "agent-1" has used its daily budget of 1 email; .*\[agent_budget_exceeded\]$/);
  assert.equal(transport.sent.length, 1);
});

test("hold_for_approval interrupts the graph and sends only after approve", async () => {
  const guard = testGuard({ approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send });
  const State = Annotation.Root({ result: Annotation<string>() });
  const graph = new StateGraph(State)
    .addNode("send", async () => {
      const text = await emailTool.invoke(input);
      return { result: String(text) };
    })
    .addEdge(START, "send")
    .addEdge("send", END)
    .compile({ checkpointer: new MemorySaver() });

  const config = { configurable: { thread_id: "receipt-1" } };
  const paused = await graph.invoke({ result: "" }, config);
  const interrupts = paused.__interrupt__;
  assert.ok(Array.isArray(interrupts) && interrupts.length === 1);
  assert.equal(interrupts[0]?.value?.reason, "recipient_requires_approval");
  assert.equal(transport.sent.length, 0);

  const resumed = await graph.invoke(new Command({ resume: { action: "approve" } }), config);
  assert.equal(resumed.result, "Sent stub-1");
  assert.equal(transport.sent.length, 1);
});

test("an approved send still counts against the budget", async () => {
  const guard = testGuard({ budgets: { perDay: 1 }, approval: { recipients: ["vip@example.com"] } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send });
  assert.equal(await emailTool.invoke(input), "Sent stub-1");
  const State = Annotation.Root({ result: Annotation<string>() });
  const graph = new StateGraph(State)
    .addNode("send", async () => ({
      result: String(await emailTool.invoke({ ...input, to: "vip@example.com" })),
    }))
    .addEdge(START, "send")
    .addEdge("send", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "receipt-3" } };
  await graph.invoke({ result: "" }, config);
  const resumed = await graph.invoke(new Command({ resume: { action: "approve" } }), config);
  assert.match(String(resumed.result), /\[agent_budget_exceeded\]$/);
  assert.equal(transport.sent.length, 1);
});

test("a declined resume does not send", async () => {
  const guard = testGuard({ approval: { recipients: ["@example.com"] } });
  const transport = stubTransport();
  const emailTool = guardedEmailTool({ guard, send: transport.send });
  const State = Annotation.Root({ result: Annotation<string>() });
  const graph = new StateGraph(State)
    .addNode("send", async () => ({ result: String(await emailTool.invoke(input)) }))
    .addEdge(START, "send")
    .addEdge("send", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "receipt-2" } };
  await graph.invoke({ result: "" }, config);
  const resumed = await graph.invoke(new Command({ resume: { action: "reject" } }), config);
  assert.match(String(resumed.result), /Approval required/);
  assert.match(String(resumed.result), /\[recipient_requires_approval\]$/);
  assert.equal(transport.sent.length, 0);
});

test("the README states blast-radius control and does not claim prompt-injection blocking", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /blast-radius control/);
  assert.doesNotMatch(readme, /prompt injection/i);
  assert.doesNotMatch(readme, /AI guardrails/i);
  assert.match(readme, /1\.7\.2/);
});

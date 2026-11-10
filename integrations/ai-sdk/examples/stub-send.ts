import { stubTransport } from "../../adapter/stub-transport.ts";
import { testGuard } from "../../adapter/test-guard.ts";
import { executeGuardedEmail, guardedEmailTool } from "../src/index.ts";

const guard = testGuard({ budgets: { perDay: 1 } });
const transport = stubTransport();
const options = { guard, send: transport.send, key: "agent-1" };
const emailTool = guardedEmailTool(options);
const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };

if (!emailTool.execute) throw new Error("ai tool() did not return execute");
const allowed = await emailTool.execute(input, { toolCallId: "call-1", messages: [] });
const refused = await executeGuardedEmail(options, { ...input, text: "Second receipt." });
process.stdout.write(`${allowed}\n${refused}\nsent ${transport.sent.length}\n`);

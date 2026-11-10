import { stubTransport } from "../../adapter/stub-transport.ts";
import { testGuard } from "../../adapter/test-guard.ts";
import { guardedEmailTool } from "../src/index.ts";

const guard = testGuard({ budgets: { perDay: 1 } });
const transport = stubTransport();
const emailTool = guardedEmailTool({ guard, send: transport.send, key: "agent-1" });
const input = { to: "user@example.com", subject: "Receipt", text: "Paid." };
if (!emailTool.execute) throw new Error("createTool() did not return execute");
const allowed = await emailTool.execute(input, {});
const refused = await emailTool.execute({ ...input, text: "Second receipt." }, {});
process.stdout.write(`${allowed}\n${refused}\nsent ${transport.sent.length}\n`);

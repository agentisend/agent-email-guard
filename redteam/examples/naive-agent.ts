import { executeScript } from '../src/script.js';
import type { AgentTools, ScenarioInput } from '../src/types.js';

/**
 * A scripted agent with no model and no API key.
 * It follows `input.script`, which is the monthly benchmark's reference behaviour:
 * a loop of 400 identical receipts, a retry after a timeout, a reply-all storm, and the rest.
 * It does not deliver mail. The harness supplies a recorder.
 */
export async function runAgent(input: ScenarioInput, tools: AgentTools): Promise<void> {
  await executeScript(input, tools);
}

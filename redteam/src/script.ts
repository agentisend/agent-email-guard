import type { AgentTools, EmailMessage, ScenarioInput, ScriptOp } from './types.js';

/**
 * Reference behaviour for the monthly benchmark.
 * A naive agent executes `input.script` and does not read the task.
 * `repeat` always runs to the end, including after a refusal.
 * `retryOnProviderError` retries a provider timeout and stops on a refusal.
 */
export async function executeScript(input: ScenarioInput, tools: AgentTools): Promise<void> {
  for (const step of input.script) {
    await runOp(step, tools);
  }
}

async function runOp(step: ScriptOp, tools: AgentTools): Promise<void> {
  switch (step.op) {
    case 'send': {
      const repeat = step.repeat ?? 1;
      const retries = step.retryOnProviderError ?? 0;
      for (let index = 1; index <= repeat; index += 1) {
        const message = step.vary === 'index' ? vary(step.message, index) : step.message;
        let result = await tools.email.send(message);
        let used = 0;
        while (!result.ok && !result.blocked && used < retries) {
          used += 1;
          result = await tools.email.send(message);
        }
      }
      return;
    }
    case 'emailEachContact': {
      const contacts = await tools.contacts.list();
      for (const to of contacts) {
        await tools.email.send({ ...step.message, to: [to] });
      }
      return;
    }
    case 'raiseLimits': {
      await tools.limits.raise({
        perHour: step.perHour,
        perMinute: step.perMinute,
        maxIdentical: step.maxIdentical,
      });
      return;
    }
    case 'replyAllStorm': {
      for (let round = 0; round < step.rounds; round += 1) {
        await tools.email.send({ to: [step.b], subject: step.subject, text: step.text });
        await tools.email.send({ to: [step.a], subject: step.subject, text: step.text });
      }
      return;
    }
    default: {
      const unknown: never = step;
      throw new Error(`Unknown script op: ${JSON.stringify(unknown)}`);
    }
  }
}

function vary(message: EmailMessage, index: number): EmailMessage {
  const token = String(index);
  return {
    ...message,
    subject: message.subject.replaceAll('{{n}}', token),
    text: message.text?.replaceAll('{{n}}', token),
    html: message.html?.replaceAll('{{n}}', token),
  };
}

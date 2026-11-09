import type {
  AgentTools,
  Bounds,
  EmailMessage,
  Guard,
  LimitChange,
  ModeResult,
  RunAgent,
  Scenario,
  ScenarioReport,
  SuiteReport,
} from './types.js';
import { addressesOf, createOpenGuard } from './guard-adapter.js';

export interface RunHarnessOptions {
  readonly runAgent: RunAgent;
  readonly scenarios: readonly Scenario[];
  readonly createGuard: () => Guard;
  readonly guardSource: 'reference' | 'node';
  readonly policyPath: string;
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
}

class SkipNoModel extends Error {
  readonly code = 'SKIP_NO_MODEL';
}

export function isSkipNoModel(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'SKIP_NO_MODEL' || (error as { code?: string }).code === 'SKIP_NO_MODEL';
}

export async function runHarness(options: RunHarnessOptions): Promise<SuiteReport> {
  const scenarios: ScenarioReport[] = [];
  for (const scenario of options.scenarios) {
    let withoutGuard: ModeResult;
    let withGuard: ModeResult;
    try {
      withoutGuard = await runOne(options.runAgent, scenario, createOpenGuard());
      withGuard = await runOne(options.runAgent, scenario, options.createGuard());
    } catch (error) {
      if (isSkipNoModel(error)) throw new SkipNoModel(error instanceof Error ? error.message : 'Skipped.');
      throw error;
    }
    scenarios.push({
      id: scenario.id,
      name: scenario.name,
      headline: scenario.headline,
      control: scenario.control,
      pass: scenarioPasses(scenario, withoutGuard, withGuard),
      withoutGuard,
      withGuard,
    });
  }
  return {
    package: 'agent-email-guard-test',
    benchmarkId: options.benchmarkId,
    benchmarkVersion: options.benchmarkVersion,
    guard: options.guardSource,
    policyPath: options.policyPath,
    pass: scenarios.every((scenario) => scenario.pass),
    scenarios,
  };
}

export { SkipNoModel };

function scenarioPasses(scenario: Scenario, withoutGuard: ModeResult, withGuard: ModeResult): boolean {
  if (scenario.control) {
    return meets(scenario.expect.withoutGuard, withoutGuard) && meets(scenario.expect.withGuard, withGuard);
  }
  return meets(scenario.expect.withGuard, withGuard);
}

function meets(bounds: Bounds, mode: ModeResult): boolean {
  if (bounds.minThrough !== undefined && mode.through < bounds.minThrough) return false;
  if (bounds.maxThrough !== undefined && mode.through > bounds.maxThrough) return false;
  if (bounds.limitsChanged !== undefined && mode.limitsChanged !== bounds.limitsChanged) return false;
  return true;
}

async function runOne(runAgent: RunAgent, scenario: Scenario, guard: Guard): Promise<ModeResult> {
  const tally = new Tally();
  const tools = createTools(scenario, guard, tally);
  await runAgent(
    {
      id: scenario.id,
      name: scenario.name,
      task: scenario.task,
      untrusted: scenario.untrusted,
      fixtures: scenario.fixtures,
      script: scenario.script,
    },
    tools,
  );
  return tally.finish();
}

function createTools(scenario: Scenario, guard: Guard, tally: Tally): AgentTools {
  return {
    email: {
      async send(message: EmailMessage) {
        tally.attempted += 1;
        const decision = guard.inspectSend(message);
        if (decision.outcome !== 'allow') {
          tally.note(decision.reason, decision.detail);
          return { ok: false, blocked: true, reason: decision.reason, message: decision.message };
        }
        guard.recordSend(message);
        tally.through += 1;
        tally.recipientsThrough += addressesOf(message).length;
        if (scenario.transport.ambiguousError) {
          return {
            ok: false,
            blocked: false,
            reason: 'provider_error',
            message: 'The fake provider accepted the message, then reported a timeout.',
            error: 'timeout',
          };
        }
        return { ok: true, blocked: false, reason: 'ok', message: decision.message };
      },
    },
    contacts: {
      async list() {
        return scenario.fixtures.contacts;
      },
    },
    limits: {
      async raise(change: LimitChange) {
        tally.limitChangesAttempted += 1;
        const decision = guard.inspectLimitChange(change);
        if (decision.outcome !== 'allow') {
          tally.note(decision.reason, decision.detail);
          return { ok: false, blocked: true, reason: decision.reason, message: decision.message };
        }
        guard.recordLimitChange(change);
        tally.limitsChanged = true;
        return { ok: true, blocked: false, reason: 'ok', message: decision.message };
      },
    },
  };
}

class Tally {
  attempted = 0;
  through = 0;
  recipientsThrough = 0;
  limitsChanged = false;
  limitChangesAttempted = 0;
  reason = 'ok';
  detail: string | null = null;
  readonly reasons: string[] = [];

  note(reason: string, detail: string | null): void {
    if (this.reason === 'ok') {
      this.reason = reason;
      this.detail = detail;
    }
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }

  finish(): ModeResult {
    return {
      attempted: this.attempted,
      through: this.through,
      blocked: this.attempted - this.through,
      recipientsThrough: this.recipientsThrough,
      reason: this.reason,
      detail: this.detail,
      reasons: this.reasons,
      limitsChanged: this.limitsChanged,
      limitChangesAttempted: this.limitChangesAttempted,
    };
  }
}

export function formatReport(report: SuiteReport): string {
  const lines: string[] = [];
  lines.push('without guard');
  lines.push(table(report, 'withoutGuard'));
  lines.push('');
  lines.push('with guard');
  lines.push(table(report, 'withGuard'));
  lines.push('');
  lines.push(report.pass ? 'pass' : 'fail');
  return lines.join('\n');
}

function table(report: SuiteReport, mode: 'withoutGuard' | 'withGuard'): string {
  const header = ['scenario', 'attempted', 'through', 'reason'];
  const rows = report.scenarios.map((scenario) => [
    scenario.id,
    String(scenario[mode].attempted),
    String(scenario[mode].through),
    scenario[mode].reason,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ');
  return [render(header), ...rows.map((row) => render(row))].join('\n');
}

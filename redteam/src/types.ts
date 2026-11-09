/** Language-neutral shapes. Python, PHP and Go runners should match these field names. */

export interface UntrustedInput {
  readonly channel: 'none' | 'email' | 'web' | 'tool';
  readonly content: string;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

export interface SendResult {
  readonly ok: boolean;
  readonly blocked: boolean;
  /** Guard reason, or `provider_error` when the fake provider reported a timeout. */
  readonly reason: string;
  readonly message: string;
  readonly error?: string;
}

export interface LimitChange {
  readonly perHour?: number;
  readonly perMinute?: number;
  readonly maxIdentical?: number;
}

export interface LimitResult {
  readonly ok: boolean;
  readonly blocked: boolean;
  readonly reason: string;
  readonly message: string;
}

export interface AgentTools {
  readonly email: {
    send(message: EmailMessage): Promise<SendResult>;
  };
  readonly contacts: {
    list(): Promise<readonly string[]>;
  };
  readonly limits: {
    raise(change: LimitChange): Promise<LimitResult>;
  };
}

export type ScriptOp =
  | {
      readonly op: 'send';
      readonly repeat?: number;
      readonly retryOnProviderError?: number;
      readonly vary?: 'index';
      readonly message: EmailMessage;
    }
  | {
      readonly op: 'emailEachContact';
      readonly message: Omit<EmailMessage, 'to'>;
    }
  | ({
      readonly op: 'raiseLimits';
    } & LimitChange)
  | {
      readonly op: 'replyAllStorm';
      readonly rounds: number;
      readonly a: string;
      readonly b: string;
      readonly subject: string;
      readonly text: string;
    };

export interface ScenarioInput {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly untrusted: UntrustedInput;
  readonly fixtures: { readonly contacts: readonly string[] };
  readonly script: readonly ScriptOp[];
}

export interface RunAgent {
  (input: ScenarioInput, tools: AgentTools): Promise<void>;
}

export interface Bounds {
  readonly minThrough?: number;
  readonly maxThrough?: number;
  readonly limitsChanged?: boolean;
}

export interface ReferenceRun {
  readonly attempted: number;
  readonly through: number;
  readonly reason: string;
  readonly detail: string | null;
  readonly limitsChanged?: boolean;
}

export interface Scenario {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly headline: boolean;
  readonly control: boolean;
  readonly untrusted: UntrustedInput;
  readonly task: string;
  readonly safe: string;
  readonly failure: string;
  readonly fixtures: { readonly contacts: readonly string[] };
  readonly transport: { readonly ambiguousError: boolean };
  readonly script: readonly ScriptOp[];
  readonly expect: { readonly withGuard: Bounds; readonly withoutGuard: Bounds };
  readonly reference: { readonly withGuard: ReferenceRun; readonly withoutGuard: ReferenceRun };
}

export interface Policy {
  readonly maxIdentical: number;
  readonly perHour: number;
  readonly perMinute: number;
  readonly maxRecipientsPerMessage: number;
  readonly maxNewRecipientsPerHour: number;
  readonly approvalForNewDomains: boolean;
  readonly knownDomains: readonly string[];
  readonly knownRecipients: readonly string[];
  readonly refuseSecretsToNewDomains: boolean;
  readonly allowSelfLimitRaise: boolean;
}

export interface GuardDecision {
  readonly outcome: 'allow' | 'hold_for_approval' | 'refuse';
  readonly reason: string;
  readonly message: string;
  readonly detail: string | null;
}

export interface Guard {
  inspectSend(message: EmailMessage): GuardDecision;
  inspectLimitChange(change: LimitChange): GuardDecision;
  /** Call only after `inspectSend` returned `allow`. */
  recordSend(message: EmailMessage): void;
  /** Call only after a limit change was allowed. */
  recordLimitChange(change: LimitChange): void;
}

export interface ModeResult {
  readonly attempted: number;
  readonly through: number;
  readonly blocked: number;
  readonly recipientsThrough: number;
  readonly reason: string;
  readonly detail: string | null;
  readonly reasons: readonly string[];
  readonly limitsChanged: boolean;
  readonly limitChangesAttempted: number;
}

export interface ScenarioReport {
  readonly id: string;
  readonly name: string;
  readonly headline: boolean;
  readonly control: boolean;
  readonly pass: boolean;
  readonly withoutGuard: ModeResult;
  readonly withGuard: ModeResult;
}

export interface SuiteReport {
  readonly package: 'agent-email-guard-test';
  readonly benchmarkId: string;
  readonly benchmarkVersion: number;
  readonly guard: 'reference' | 'node';
  readonly policyPath: string;
  readonly pass: boolean;
  readonly scenarios: readonly ScenarioReport[];
}

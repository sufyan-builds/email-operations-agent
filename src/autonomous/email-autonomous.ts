/**
 * HazelJS Autonomous Application Runtime (AAR) demonstration for Email Operations.
 *
 * This module works alongside the existing AgentRuntime pipeline without replacing it.
 * It demonstrates HazelJS AAR primitives:
 *   - `@Autonomous` service declaration (`mode: 'approval-required'`)
 *   - `@Observe` event listener (`email.received`)
 *   - `@Capability` governed methods (`email.draft_reply`, `email.flag_for_review`)
 *   - `AutonomousRuntime` with `simulation: true` hard safety barrier
 *   - Human-in-the-loop pause/resume (`waiting_for_human` -> `resume()`)
 *   - Durable in-memory run history (`listRuns()`) and audit timeline (`timeline()`)
 */
import 'reflect-metadata';
import {
  Autonomous,
  AutonomousRuntime,
  Capability,
  MemoryAutonomousRunStore,
  Observe,
  clearAutonomousRegistry,
  type AarTimelineEvent,
  type AutonomousRunRecord,
} from '@hazeljs/autonomous';
import { evaluateAction, validateTriage } from '../policy/policy-gate';
import { RuleBasedTriage, type TriageEngine } from '../triage/triage';
import type { ActionType, Email, PolicyDecision, TriageResult } from '../types';

export const EMAIL_RECEIVED_EVENT = 'email.received';
export const CAPABILITY_DRAFT_REPLY = 'email.draft_reply';
export const CAPABILITY_FLAG_REVIEW = 'email.flag_for_review';

export interface ObservedEmailAnalysis {
  email: Email;
  triage: TriageResult | null;
  policy: PolicyDecision;
  proposedAction: ActionType;
  draftResponse: string;
}

/**
 * Governed Autonomous Service for Email Operations.
 *
 * Configured with `mode: 'approval-required'` so outward-facing actions pause
 * for human approval before execution.
 */
@Autonomous({
  id: 'email-operations-autonomous',
  objective: 'Triage incoming emails under deterministic policy and prepare safe replies with human approval',
  mode: 'approval-required',
  capabilities: [CAPABILITY_DRAFT_REPLY, CAPABILITY_FLAG_REVIEW],
  policies: ['policy-gate-verified', 'human-approval-before-reply', 'simulation-only'],
  loopProtection: { maxDepth: 3, cooldownMs: 0, maxActionsPerRun: 5 },
})
export class AutonomousEmailService {
  /** Tracks whether a live capability method body was ever invoked. */
  readonly liveInvocations: Array<{ capabilityId: string; input: unknown }> = [];
  private triageEngine: TriageEngine = new RuleBasedTriage();

  setTriageEngine(engine: TriageEngine): void {
    this.triageEngine = engine;
  }

  /**
   * 1. OBSERVE: Receives an incoming email event, runs the existing triage engine
   *    and deterministic policy gate, and returns the structured analysis.
   */
  @Observe(EMAIL_RECEIVED_EVENT)
  async onEmailReceived(email: Email): Promise<ObservedEmailAnalysis> {
    const raw = await this.triageEngine.triage(email);
    const validation = validateTriage(raw);
    const triage = validation.ok ? validation.triage : null;

    const proposed = triage ? triage.suggestedAction : null;
    const policy = triage
      ? evaluateAction(email, triage, proposed)
      : {
          verdict: 'block' as const,
          action: null,
          reasons: [`Invalid triage output (${validation.ok ? 'unknown' : validation.error}); failing safe.`],
          fallbackAction: 'flag_for_review' as const,
        };

    const proposedAction: ActionType =
      policy.verdict === 'block' ? (policy.fallbackAction ?? 'flag_for_review') : (policy.action ?? 'flag_for_review');

    return {
      email,
      triage,
      policy,
      proposedAction,
      draftResponse:
        triage?.draftResponse ??
        'Hello,\n\nThank you for your email. Our team has received your message and will follow up shortly.\n\nBest regards,\nSupport Team',
    };
  }

  /**
   * 2. CAPABILITY (Outward-facing): Prepare and send a reply.
   *    Marked `effect: 'irreversible'` and `approval: 'required'`.
   *    When `AutonomousRuntime` runs with `simulation: true`, the runtime's hard
   *    simulation barrier intercepts execution before this method body runs.
   */
  @Capability({
    id: CAPABILITY_DRAFT_REPLY,
    effect: 'irreversible',
    approval: 'required',
    idempotencyKey: true,
  })
  draftReply(input: { emailId: string; to: string; subject: string; body: string; category: string }) {
    this.liveInvocations.push({ capabilityId: CAPABILITY_DRAFT_REPLY, input });
    return {
      sentTo: input.to,
      subject: input.subject,
      body: input.body,
    };
  }

  /**
   * 3. CAPABILITY (Internal queue): Flag an email for human review when blocked by policy.
   */
  @Capability({
    id: CAPABILITY_FLAG_REVIEW,
    effect: 'idempotent',
    approval: 'auto',
    idempotencyKey: true,
  })
  flagForReview(input: { emailId: string; from: string; subject: string; reasons: string[] }) {
    this.liveInvocations.push({ capabilityId: CAPABILITY_FLAG_REVIEW, input });
    return {
      flaggedEmailId: input.emailId,
      reasons: input.reasons,
    };
  }
}

/**
 * Creates a fresh `AutonomousRuntime` configured for Email Operations with:
 *   - `simulation: true` (HazelJS hard barrier against live side effects)
 *   - `MemoryAutonomousRunStore` for inspectable run history and timelines
 *   - Deterministic decision engine that respects the policy gate verdict
 */
export async function createAutonomousEmailRuntime(triageEngine?: TriageEngine): Promise<{
  runtime: AutonomousRuntime;
  service: AutonomousEmailService;
  store: MemoryAutonomousRunStore;
}> {
  clearAutonomousRegistry();
  const store = new MemoryAutonomousRunStore();
  const service = new AutonomousEmailService();
  if (triageEngine) service.setTriageEngine(triageEngine);

  const runtime = new AutonomousRuntime({
    storage: store,
    autoDiscover: false,
    services: [AutonomousEmailService],
    simulation: true, // Hard safety barrier: no live capability side effects can ever run
    loopProtection: { maxDepth: 3, cooldownMs: 0, maxActionsPerRun: 5 },
    decisionEngine: {
      async evaluate(ctx) {
        const analysis = ctx.observation.payload as ObservedEmailAnalysis;

        // If the policy gate blocked the email (e.g. prompt injection, spam, low confidence),
        // route to the safe review capability rather than proposing a reply.
        if (analysis.policy.verdict === 'block' || analysis.proposedAction !== 'draft_reply') {
          return {
            type: 'request-approval',
            capabilityId: CAPABILITY_FLAG_REVIEW,
            arguments: {
              emailId: analysis.email.id,
              from: analysis.email.from,
              subject: analysis.email.subject,
              reasons: analysis.policy.reasons,
            },
            reason: `Policy verdict [${analysis.policy.verdict.toUpperCase()}]: ${analysis.policy.reasons.join(' ')}`,
          };
        }

        // Policy allows proposing a reply with human approval
        return {
          type: 'request-approval',
          capabilityId: CAPABILITY_DRAFT_REPLY,
          arguments: {
            emailId: analysis.email.id,
            to: analysis.email.from,
            subject: `Re: ${analysis.email.subject}`,
            body: analysis.draftResponse,
            category: analysis.triage?.category ?? 'unknown',
          },
          reason: analysis.policy.reasons.join(' '),
        };
      },
    },
  });

  runtime.bindInstance(AutonomousEmailService, service);
  await runtime.start();

  return { runtime, service, store };
}

export interface AutonomousScenarioResult {
  runId: string;
  beforeApproval: AutonomousRunRecord;
  afterResume: AutonomousRunRecord;
  timeline: AarTimelineEvent[];
}

/**
 * Emits an `email.received` observation, captures the paused `approval_pending`
 * state, resumes the run with the reviewer's decision (`approved: true | false`),
 * and returns the completed/cancelled run record and timeline.
 */
export async function runAutonomousEmailScenario(
  runtime: AutonomousRuntime,
  email: Email,
  approval: { approved: boolean; actor: string },
): Promise<AutonomousScenarioResult> {
  const [runId] = await runtime.emit(EMAIL_RECEIVED_EVENT, email, {
    source: 'email-inbox-simulator',
    subject: email.id,
    tenantId: 'demo-workspace',
  });
  if (!runId) {
    throw new Error('AutonomousRuntime did not create a run for email.received');
  }

  const beforeApproval = await runtime.inspect(runId);
  if (!beforeApproval) {
    throw new Error(`Run ${runId} not found before approval`);
  }

  // Clone the snapshot before resume mutates the stored record
  const snapshotBefore: AutonomousRunRecord = JSON.parse(JSON.stringify(beforeApproval));

  await runtime.resume(runId, approval);

  const afterResume = await runtime.inspect(runId);
  if (!afterResume) {
    throw new Error(`Run ${runId} not found after resume`);
  }

  const timeline = await runtime.timeline(runId);
  return {
    runId,
    beforeApproval: snapshotBefore,
    afterResume,
    timeline,
  };
}

/**
 * Formats an AAR scenario result into a clear, beginner-friendly console report.
 */
export function formatAutonomousScenario(label: string, email: Email, result: AutonomousScenarioResult): string {
  const { runId, beforeApproval, afterResume, timeline } = result;
  const decision = afterResume.metadata.decision;
  const lines: string[] = [];

  lines.push('='.repeat(72));
  lines.push(`AAR SCENARIO: ${label}`);
  lines.push(`EMAIL         [${email.id}] From: ${email.from} | Subject: ${email.subject}`);
  lines.push('-'.repeat(72));
  lines.push(`Run ID:                 ${runId}`);
  lines.push(`Service ID:             ${afterResume.serviceId}`);
  lines.push(`Autonomous Mode:        ${afterResume.metadata.mode}`);
  lines.push(`Simulation Barrier:     ${afterResume.metadata.dryRun ? 'ENABLED (simulation: true)' : 'disabled'}`);
  lines.push(`Proposed Capability:    ${afterResume.metadata.capabilityId ?? '(none)'}`);
  lines.push(`Decision Reason:        ${decision && 'reason' in decision ? decision.reason : '(none)'}`);
  lines.push(`Status Before Approval: ${beforeApproval.status} (phase: ${beforeApproval.metadata.phase})`);
  lines.push(`Status After Resume:    ${afterResume.status} (phase: ${afterResume.metadata.phase})`);
  if (afterResume.output) {
    lines.push(`Simulated Output:       ${JSON.stringify(afterResume.output)}`);
  }
  lines.push('Timeline:');
  for (const event of timeline) {
    const detail = event.detail ? ` — ${event.detail}` : '';
    lines.push(`  - [${event.type}]${detail}`);
  }
  return lines.join('\n');
}

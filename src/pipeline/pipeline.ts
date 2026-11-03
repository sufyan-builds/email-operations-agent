/**
 * The end-to-end workflow:
 *
 *   receive -> triage -> validate -> policy gate -> (approval) -> agent -> result
 *
 * The pipeline never executes anything itself. It hands an authorized,
 * minimal instruction to the HazelJS agent runtime; the tools run through the
 * ActionExecutor, which re-verifies authorization.
 */
import 'reflect-metadata';
import { AgentEventType, AgentRuntime } from '@hazeljs/agent';
import { ActionExecutor } from '../execution/action-executor';
import { AGENT_NAME, EmailOpsAgent, PlannerLLM, buildInstruction } from '../agent/email-ops-agent';
import { ApprovalProvider, askForApproval } from '../approval/approval';
import { evaluateAction, validateTriage } from '../policy/policy-gate';
import { RuleBasedTriage, TriageEngine } from '../triage/triage';
import {
  ApprovalStatus,
  Email,
  ExecutionResult,
  PolicyDecision,
  TriageResult,
} from '../types';

export interface PipelineReport {
  email: Email;
  runId: string;
  triage: TriageResult | null;
  validationError?: string;
  /** What the triage engine suggested (may be absent if output was invalid). */
  proposedAction: string | null;
  policy: PolicyDecision;
  /** Present when the proposal was blocked and the safe fallback was evaluated. */
  fallbackPolicy?: PolicyDecision;
  /** The action that was actually put forward for execution (null if none). */
  finalAction: string | null;
  approval: ApprovalStatus;
  approvalNote: string;
  execution: ExecutionResult;
}

export interface PipelineOptions {
  triage?: TriageEngine;
  approval: ApprovalProvider;
  executor?: ActionExecutor;
  /** Approval timeout in ms (default 120000). */
  approvalTimeoutMs?: number;
}

export class EmailOperationsPipeline {
  readonly executor: ActionExecutor;
  private readonly triage: TriageEngine;
  private readonly approval: ApprovalProvider;
  private readonly runtime: AgentRuntime;
  private readonly approvalTimeoutMs: number;
  private counter = 0;
  /** runId -> info the approval handler needs (email, outcome). */
  private readonly runs = new Map<string, { email: Email; status: ApprovalStatus; note: string }>();

  constructor(opts: PipelineOptions) {
    this.triage = opts.triage ?? new RuleBasedTriage();
    this.approval = opts.approval;
    this.executor = opts.executor ?? new ActionExecutor();
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 120_000;

    this.runtime = new AgentRuntime({
      llmProvider: new PlannerLLM(),
      defaultMaxSteps: 6,
      logLevel: 3 as never, // LogLevel.ERROR (enum is not exported from the package index)
    });
    this.runtime.registerAgent(EmailOpsAgent as never);
    this.runtime.registerAgentInstance(AGENT_NAME, new EmailOpsAgent(this.executor));

    // HazelJS human-in-the-loop hook: the runtime pauses requiresApproval tools
    // and emits this event; we ask the human and then approve/reject.
    this.runtime.on(AgentEventType.TOOL_APPROVAL_REQUESTED, (event: unknown) => {
      void this.handleApprovalRequest(event);
    });
  }

  private async handleApprovalRequest(event: unknown): Promise<void> {
    const data = (event as { data?: { requestId?: string; input?: { runId?: string } } }).data ?? {};
    const requestId = data.requestId;
    const runId = data.input?.runId;
    if (!requestId) return;
    const run = runId ? this.runs.get(runId) : undefined;

    // Unknown run => reject. Never approve something we can't trace.
    if (!runId || !run) {
      this.runtime.rejectToolExecution(requestId);
      return;
    }
    const outcome = await askForApproval(
      this.approval,
      {
        email: run.email,
        action: 'draft_reply',
        preview: this.executor.getDraftText(runId) ?? '(no draft)',
      },
      this.approvalTimeoutMs,
    );
    run.status = outcome.status;
    run.note = outcome.note;
    this.executor.recordApproval(runId, outcome.status);
    if (outcome.status === 'approved') this.runtime.approveToolExecution(requestId, 'human-reviewer');
    else this.runtime.rejectToolExecution(requestId);
  }

  async process(email: Email): Promise<PipelineReport> {
    const runId = `${email.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${++this.counter}`;

    // 1) Triage (untrusted output)
    let raw: unknown;
    let triageError: string | undefined;
    try {
      raw = await this.triage.triage(email);
    } catch (e) {
      triageError = `triage engine threw: ${(e as Error).message}`;
    }

    // 2) Validate before anything else sees it
    const validation = triageError ? { ok: false as const, error: triageError } : validateTriage(raw);
    const triage = validation.ok ? validation.triage : null;

    // 3) Policy gate on the proposed action
    const proposed = triage ? triage.suggestedAction : null;
    const policy: PolicyDecision = triage
      ? evaluateAction(email, triage, proposed)
      : {
          verdict: 'block',
          action: null,
          reasons: [`Triage output invalid or missing (${validation.ok ? 'unknown' : validation.error}); failing safe.`],
          fallbackAction: 'flag_for_review',
        };

    // 4) If blocked, the only thing we may do is the safe fallback - which also goes through the gate.
    let effective = policy;
    let fallbackPolicy: PolicyDecision | undefined;
    if (policy.verdict === 'block' && policy.fallbackAction) {
      fallbackPolicy = evaluateAction(email, triage, policy.fallbackAction);
      effective = { ...fallbackPolicy, reasons: [...policy.reasons, ...fallbackPolicy.reasons] };
    }

    const base = {
      email,
      runId,
      triage,
      validationError: validation.ok ? undefined : validation.error,
      proposedAction: proposed,
      policy,
      fallbackPolicy,
      finalAction: effective.verdict === 'block' ? null : effective.action,
    };

    if (effective.verdict === 'block' || !effective.action) {
      return {
        ...base,
        approval: 'not_requested',
        approvalNote: 'Blocked by policy; nobody was asked to approve.',
        execution: { status: 'not_executed', simulated: true, detail: 'Blocked by policy gate.' },
      };
    }

    // 5) Register the authorization, then run the agent.
    this.executor.authorize(runId, email, effective, {
      draftText: effective.action === 'draft_reply' ? triage?.draftResponse : undefined,
      label: triage?.category,
    });
    this.runs.set(runId, {
      email,
      status: effective.verdict === 'require_approval' ? 'invalid' : 'not_required',
      note: effective.verdict === 'require_approval' ? 'No approval was recorded.' : 'No approval required.',
    });

    let agentError: string | undefined;
    try {
      await this.runtime.execute(AGENT_NAME, buildInstruction(runId, effective.action), {
        sessionId: runId,
        enableMemory: false,
      });
    } catch (e) {
      agentError = (e as Error).message;
    }

    const run = this.runs.get(runId)!;
    const execution: ExecutionResult =
      this.executor.getResult(runId) ??
      (agentError
        ? { status: 'failed', simulated: true, detail: `Agent run failed safely: ${agentError}` }
        : {
            status: 'not_executed',
            simulated: true,
            detail:
              effective.verdict === 'require_approval'
                ? `Not executed: approval ${run.status}.`
                : 'Agent finished without executing an action.',
          });

    return { ...base, approval: run.status, approvalNote: run.note, execution };
  }
}

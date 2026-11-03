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
  ACTION_TYPES,
  ActionType,
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
  /**
   * Approval timeout in ms (default 120000). Invalid values fall back to the
   * default; values above MAX_APPROVAL_TIMEOUT_MS are capped to it.
   */
  approvalTimeoutMs?: number;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/**
 * The HazelJS runtime expires a pending approval after 300000 ms
 * (ToolExecutor.DEFAULT_APPROVAL_TTL_MS in @hazeljs/agent 2.0.13, not exported
 * by the package). Our own timeout must fire first so the pipeline records a
 * fail-closed "invalid" outcome instead of the runtime silently expiring the
 * request while the human is still being prompted.
 */
export const RUNTIME_APPROVAL_LIMIT_MS = 300_000;
export const MAX_APPROVAL_TIMEOUT_MS = RUNTIME_APPROVAL_LIMIT_MS - 5_000;

/** Returns a safe approval timeout: default if missing/invalid, capped below the runtime limit. */
export function resolveApprovalTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(value, MAX_APPROVAL_TIMEOUT_MS);
}

/**
 * Extracts what the approval handler needs from a HazelJS
 * TOOL_APPROVAL_REQUESTED event. Returns null for anything missing or
 * malformed, including a tool name that is not a known action.
 */
export function parseApprovalEvent(
  event: unknown,
): { requestId: string; runId: string; action: ActionType } | null {
  const data = (event as { data?: unknown } | null | undefined)?.data as
    | { requestId?: unknown; toolName?: unknown; input?: { runId?: unknown } | null }
    | undefined;
  if (!data || typeof data !== 'object') return null;
  const { requestId, toolName } = data;
  const runId = data.input?.runId;
  if (typeof requestId !== 'string' || !requestId) return null;
  if (typeof runId !== 'string' || !runId) return null;
  if (typeof toolName !== 'string' || !(ACTION_TYPES as readonly string[]).includes(toolName)) return null;
  return { requestId, runId, action: toolName as ActionType };
}

export class EmailOperationsPipeline {
  readonly executor: ActionExecutor;
  private readonly triage: TriageEngine;
  private readonly approval: ApprovalProvider;
  private readonly runtime: AgentRuntime;
  private readonly planner: PlannerLLM;
  private readonly approvalTimeoutMs: number;
  private counter = 0;
  /** runId -> info the approval handler needs (email, outcome). */
  private readonly runs = new Map<string, { email: Email; status: ApprovalStatus; note: string }>();

  constructor(opts: PipelineOptions) {
    this.triage = opts.triage ?? new RuleBasedTriage();
    this.approval = opts.approval;
    this.executor = opts.executor ?? new ActionExecutor();
    this.approvalTimeoutMs = resolveApprovalTimeoutMs(opts.approvalTimeoutMs);

    this.planner = new PlannerLLM();
    this.runtime = new AgentRuntime({
      llmProvider: this.planner,
      defaultMaxSteps: 6,
      logLevel: 3 as never, // LogLevel.ERROR (enum is not exported from the package index)
    });
    this.runtime.registerAgent(EmailOpsAgent as never);
    this.runtime.registerAgentInstance(AGENT_NAME, new EmailOpsAgent(this.executor));

    // HazelJS human-in-the-loop hook: the runtime pauses requiresApproval tools
    // and emits this event; we ask the human and then approve/reject.
    this.runtime.on(AgentEventType.TOOL_APPROVAL_REQUESTED, (event: unknown) => {
      this.handleApprovalRequest(event).catch((e: unknown) => {
        // Never leave an unhandled rejection or a hanging approval: fail closed.
        const requestId = (event as { data?: { requestId?: string } }).data?.requestId;
        try {
          if (requestId) this.runtime.rejectToolExecution(requestId);
        } catch {
          /* runtime already settled this request */
        }
        console.error(`Approval handler error (request rejected): ${(e as Error).message}`);
      });
    });
  }

  private async handleApprovalRequest(event: unknown): Promise<void> {
    const parsed = parseApprovalEvent(event);
    if (!parsed) {
      // Malformed event: reject if we can at least identify the request, otherwise nothing to answer.
      const rid = (event as { data?: { requestId?: unknown } } | null | undefined)?.data?.requestId;
      if (typeof rid === 'string' && rid) this.runtime.rejectToolExecution(rid);
      return;
    }
    const { requestId, runId, action } = parsed;
    const run = this.runs.get(runId);

    // Unknown run => reject. Never approve something we can't trace.
    if (!run) {
      this.runtime.rejectToolExecution(requestId);
      return;
    }
    const outcome = await askForApproval(
      this.approval,
      {
        email: run.email,
        action,
        preview: this.executor.getDraftText(runId) ?? '(no preview available)',
      },
      this.approvalTimeoutMs,
    );
    run.status = outcome.status;
    run.note = outcome.note;
    this.executor.recordApproval(runId, outcome.status);
    if (outcome.status === 'approved') this.runtime.approveToolExecution(requestId, this.approval.reviewerLabel ?? 'approval provider');
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
    } finally {
      // Per-run state is only needed while the run is in flight.
      this.runs.delete(runId);
      this.planner.forget(runId);
      this.executor.release(runId);
    }
  }
}

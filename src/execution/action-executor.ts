/**
 * ACTION EXECUTOR (simulated).
 *
 * Defense in depth: even though the pipeline only starts the agent after the
 * policy gate, this class independently refuses to run anything that has no
 * matching authorization in its ledger. An authorization is only created by
 * the pipeline from a policy decision, and approval is recorded separately.
 *
 * "Execution" here only touches in-memory arrays (a fake outbox / queues).
 * NOTHING is sent and no real mailbox or external system is touched.
 */
import { ActionType, Email, ExecutionResult, PolicyDecision } from '../types';

interface LedgerEntry {
  email: Email;
  decision: PolicyDecision;
  draftText?: string;
  label?: string;
  approval: 'pending' | 'approved' | 'rejected' | 'invalid';
  consumed: boolean;
  result?: ExecutionResult;
}

export class ActionExecutor {
  /** Fake "sent" folder - holds drafts that were approved and "sent". */
  readonly simulatedOutbox: Array<{ to: string; subject: string; body: string }> = [];
  readonly reviewQueue: Array<{ emailId: string; reason: string }> = [];
  readonly labels: Array<{ emailId: string; label: string }> = [];
  private readonly ledger = new Map<string, LedgerEntry>();

  /** Called by the pipeline AFTER the policy gate produced a decision. */
  authorize(
    runId: string,
    email: Email,
    decision: PolicyDecision,
    extras: { draftText?: string; label?: string } = {},
  ): void {
    this.ledger.set(runId, { email, decision, ...extras, approval: 'pending', consumed: false });
  }

  /** Records the human's answer. Only the exact value "approved" counts. */
  recordApproval(runId: string, status: 'approved' | 'rejected' | 'invalid'): void {
    const entry = this.ledger.get(runId);
    if (entry) entry.approval = status;
  }

  getResult(runId: string): ExecutionResult | undefined {
    return this.ledger.get(runId)?.result;
  }

  /** The text that would be sent if approved (used for the approval preview). */
  getDraftText(runId: string): string | undefined {
    return this.ledger.get(runId)?.draftText;
  }

  /**
   * Run one action. Every call is checked against the ledger; the content of
   * the side effect always comes from the ledger, never from caller input.
   */
  execute(runId: string, action: ActionType): ExecutionResult {
    const refuse = (detail: string): ExecutionResult => {
      const result: ExecutionResult = { status: 'refused', simulated: true, detail };
      const entry = this.ledger.get(runId);
      if (entry) entry.result = result;
      return result;
    };

    const entry = this.ledger.get(runId);
    if (!entry) return refuse('No authorization on record for this run.');
    if (entry.consumed) return refuse('Authorization already used (one execution per decision).');
    if (entry.decision.action !== action) {
      return refuse(`Requested "${action}" but policy authorized "${entry.decision.action}".`);
    }

    const verdict = entry.decision.verdict;
    if (verdict === 'block') return refuse('Policy verdict is "block".');
    if (verdict === 'require_approval' && entry.approval !== 'approved') {
      return refuse(`Approval required but status is "${entry.approval}".`);
    }
    if (verdict !== 'allow' && verdict !== 'require_approval') return refuse('Unknown policy verdict.');

    entry.consumed = true;
    try {
      let detail: string;
      switch (action) {
        case 'draft_reply':
          if (!entry.draftText) throw new Error('no draft text available');
          this.simulatedOutbox.push({
            to: entry.email.from,
            subject: `Re: ${entry.email.subject}`,
            body: entry.draftText,
          });
          detail = `SIMULATED: reply to ${entry.email.from} placed in simulated outbox (not really sent).`;
          break;
        case 'flag_for_review':
          this.reviewQueue.push({ emailId: entry.email.id, reason: entry.decision.reasons.join(' ') });
          detail = 'SIMULATED: email added to the human review queue.';
          break;
        case 'categorize':
          this.labels.push({ emailId: entry.email.id, label: entry.label ?? 'uncategorized' });
          detail = `SIMULATED: label "${entry.label ?? 'uncategorized'}" recorded (no real mailbox modified).`;
          break;
        case 'no_action':
          detail = 'No action taken.';
          break;
        default:
          throw new Error('unsupported action');
      }
      const result: ExecutionResult = { status: 'simulated_executed', simulated: true, detail };
      entry.result = result;
      return result;
    } catch (e) {
      const result: ExecutionResult = {
        status: 'failed',
        simulated: true,
        detail: `Execution failed safely: ${(e as Error).message}`,
      };
      entry.result = result;
      return result;
    }
  }
}

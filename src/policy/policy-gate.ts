/**
 * POLICY GATE - deterministic safety rules.
 *
 * Pure functions: no AI, no I/O, no randomness. The triage engine can only
 * *suggest* an action; this module decides whether it is allowed.
 *
 * Fail-safe principle: anything missing, malformed or unexpected => `block`
 * (with `flag_for_review` as the harmless fallback).
 */
import {
  ACTION_TYPES,
  ActionType,
  Email,
  PolicyDecision,
  TriageResult,
  TriageResultSchema,
} from '../types';
import { scanForInjection } from './injection';

/** Below this confidence the system will not act on its own guess. */
export const MIN_CONFIDENCE = 0.6;

/**
 * Action table. `sideEffect` actions create/send something outward-facing and
 * therefore always need explicit human approval. The others only touch the
 * app's own simulated triage queue.
 */
export const ACTION_RULES: Record<ActionType, { requiresApproval: boolean; description: string }> = {
  draft_reply: { requiresApproval: true, description: 'Prepare a reply that would be sent to the sender' },
  flag_for_review: { requiresApproval: false, description: 'Put the email in the human review queue' },
  categorize: { requiresApproval: false, description: 'Assign an internal label to the email' },
  no_action: { requiresApproval: false, description: 'Leave the email untouched' },
};

export type ValidationOutcome =
  | { ok: true; triage: TriageResult }
  | { ok: false; error: string };

/** Validate untrusted triage output against the schema. Never throws. */
export function validateTriage(raw: unknown): ValidationOutcome {
  try {
    const parsed = TriageResultSchema.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { ok: false, error: msg };
    }
    return { ok: true, triage: parsed.data };
  } catch (e) {
    return { ok: false, error: `validation crashed: ${(e as Error).message}` };
  }
}

const block = (action: ActionType | null, reasons: string[]): PolicyDecision => ({
  verdict: 'block',
  action,
  reasons,
  fallbackAction: 'flag_for_review',
});

/**
 * Decide what may happen to one proposed action for one email.
 * `triage` may be null when triage output was invalid.
 */
export function evaluateAction(
  email: Email,
  triage: TriageResult | null,
  action: unknown,
): PolicyDecision {
  try {
    if (typeof action !== 'string' || !(ACTION_TYPES as readonly string[]).includes(action)) {
      return block(null, [`Unknown action "${String(action)}"; failing safe.`]);
    }
    const act = action as ActionType;
    const rule = ACTION_RULES[act];

    // The review queue is the safe harbor: always permitted, never needs approval.
    if (act === 'flag_for_review') {
      return { verdict: 'allow', action: act, reasons: ['Flagging for review is a safe internal action.'] };
    }

    if (!triage) return block(act, ['Triage output was missing or invalid; failing safe.']);

    const reasons: string[] = [];

    const scan = scanForInjection(email.subject, email.body);
    if (scan.suspicious) {
      reasons.push(`Email contains instructions aimed at the agent (${scan.matches.join(', ')}); treated as untrusted.`);
    }
    if (triage.category === 'spam') reasons.push('Email classified as spam/suspicious; no automatic action.');
    if (triage.confidence < MIN_CONFIDENCE) {
      reasons.push(`Confidence ${triage.confidence} is below the ${MIN_CONFIDENCE} threshold.`);
    }
    if (triage.category === 'unknown') reasons.push('Category is unknown.');
    if (reasons.length > 0) return block(act, reasons);

    if (rule.requiresApproval) {
      return {
        verdict: 'require_approval',
        action: act,
        reasons: [`"${act}" could produce an outward-facing side effect; human approval required.`],
      };
    }
    return { verdict: 'allow', action: act, reasons: [`"${act}" is low-risk and allowed by policy.`] };
  } catch (e) {
    return block(null, [`Policy evaluation error (${(e as Error).message}); failing safe.`]);
  }
}

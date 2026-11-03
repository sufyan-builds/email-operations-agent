/**
 * Shared types and schemas.
 *
 * The zod schema below is the "contract" for the triage output. Anything the
 * triage engine (rules today, maybe an LLM tomorrow) returns is treated as
 * UNTRUSTED until it passes this schema.
 */
import { z } from 'zod';

export const CATEGORIES = [
  'customer_inquiry',
  'complaint',
  'meeting_request',
  'job_opportunity',
  'spam',
  'unknown',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ACTION_TYPES = ['draft_reply', 'flag_for_review', 'categorize', 'no_action'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const URGENCIES = ['low', 'medium', 'high'] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export const TriageResultSchema = z
  .object({
    category: z.enum(CATEGORIES),
    /** 0..1 — how sure the engine is about the category. */
    confidence: z.number().min(0).max(1),
    intent: z.object({
      summary: z.string().min(1),
      request: z.string(),
      requiredResponse: z.string(),
    }),
    keyDetails: z.array(z.string()),
    urgency: z.enum(URGENCIES),
    suggestedAction: z.enum(ACTION_TYPES),
    /** Only present when suggestedAction is draft_reply (or as a suggestion for review). */
    draftResponse: z.string().optional(),
    /** Short, user-facing explanation. */
    reasoning: z.string().min(1),
  })
  .strict();
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** The three outcomes the policy gate can produce. */
export type PolicyVerdict = 'allow' | 'require_approval' | 'block';

export interface PolicyDecision {
  verdict: PolicyVerdict;
  /** The action the verdict applies to (null if the proposal was unusable). */
  action: ActionType | null;
  reasons: string[];
  /** Safe action to use instead when the proposal is blocked. */
  fallbackAction?: ActionType;
}

export type ApprovalStatus =
  | 'not_required'
  | 'approved'
  | 'rejected'
  | 'not_requested' // gate blocked it, so nobody was asked
  | 'invalid'; // provider answered with something unexpected / failed

export type ExecutionStatus =
  | 'simulated_executed'
  | 'not_executed'
  | 'refused' // defense-in-depth check inside the executor said no
  | 'failed';

export interface ExecutionResult {
  status: ExecutionStatus;
  /** Always true in this version: nothing real is ever sent or modified. */
  simulated: true;
  detail: string;
}

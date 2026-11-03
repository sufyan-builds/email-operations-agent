/**
 * Triage engine: classify + extract intent + RECOMMEND an action.
 *
 * It only recommends. It has no power to execute anything. The default engine
 * is rule-based so the project runs offline without an API key; the
 * `TriageEngine` interface is the swap point for an LLM-backed engine.
 *
 * The return type is `unknown` on purpose: callers must validate it with
 * `TriageResultSchema` before trusting it.
 */
import { Email } from '../types';

export interface TriageEngine {
  triage(email: Email): Promise<unknown> | unknown;
}

const KEYWORDS: Record<string, Array<[RegExp, number]>> = {
  spam: [
    [/\b(congratulations|you won|winner|lottery|prize|free gift)\b/i, 2],
    [/\b(click here|act now|limited time|claim your)\b/i, 2],
    [/\b(password|bank|wire transfer|crypto|unsubscribe)\b/i, 1],
    [/!{3,}/, 1],
  ],
  complaint: [
    [/\b(complain|unacceptable|disappointed|terrible|angry|broken|damaged|refund|worst)\b/i, 2],
    [/\b(not working|no response|nobody (has )?answered|never arrived)\b/i, 2],
  ],
  meeting_request: [
    [/\b(meeting|meet|call|demo|schedule|appointment|catch up)\b/i, 2],
    [/\b(available|availability|calendar|time slot)\b/i, 1],
    [/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i, 1],
  ],
  job_opportunity: [
    [/\b(job|position|role|vacancy|opening|hiring|recruiter|career)\b/i, 2],
    [/\b(salary|resume|cv|interview|apply|applying)\b/i, 1],
  ],
  customer_inquiry: [
    [/\b(how much|price|pricing|cost|plan|does it|do you|can you tell|question|information|support)\b/i, 2],
    [/\?/, 1],
  ],
};

const DEFAULT_ACTION: Record<string, 'draft_reply' | 'flag_for_review' | 'categorize' | 'no_action'> = {
  customer_inquiry: 'draft_reply',
  complaint: 'draft_reply',
  meeting_request: 'draft_reply',
  job_opportunity: 'categorize',
  spam: 'flag_for_review',
  unknown: 'flag_for_review',
};

function scoreCategories(text: string): Array<[string, number]> {
  return Object.entries(KEYWORDS)
    .map(([cat, rules]) => {
      const score = rules.reduce((s, [re, w]) => s + (re.test(text) ? w : 0), 0);
      return [cat, score] as [string, number];
    })
    .sort((a, b) => b[1] - a[1]);
}

export function extractKeyDetails(email: Email): string[] {
  const text = `${email.subject}\n${email.body}`;
  const details: string[] = [`Sender: ${email.from}`];
  const order = text.match(/#\d{3,}/);
  if (order) details.push(`Order reference: ${order[0]}`);
  const time = text.match(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
  if (time) details.push(`Time mentioned: ${time[0]}`);
  const day = text.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i);
  if (day) details.push(`Day mentioned: ${day[0]}`);
  const duration = text.match(/\b\d+\s*(minute|min|hour)s?\b/i);
  if (duration) details.push(`Duration: ${duration[0]}`);
  return details;
}

function detectUrgency(text: string): 'low' | 'medium' | 'high' {
  if (/\b(urgent|asap|immediately|today|right now|emergency)\b/i.test(text)) return 'high';
  if (/\b(soon|this week|tomorrow|deadline|follow(ing)? up)\b/i.test(text)) return 'medium';
  return 'low';
}

const DRAFTS: Record<string, (e: Email) => string> = {
  customer_inquiry: () =>
    'Hello,\n\nThank you for your interest. We will share the pricing and support details ' +
    'you asked about shortly. Please let us know if you have any other questions.\n\nBest regards,\nSupport Team',
  complaint: () =>
    'Hello,\n\nWe are sorry about the problem you experienced and take it seriously. A member ' +
    'of our support team will review your case and contact you with next steps.\n\nBest regards,\nSupport Team',
  meeting_request: () =>
    'Hello,\n\nThank you for reaching out. We will check our calendar and confirm a suitable ' +
    'time shortly.\n\nBest regards,\nTeam',
};

export class RuleBasedTriage implements TriageEngine {
  triage(email: Email) {
    const text = `${email.subject}\n${email.body}`;
    const [[topCat, topScore], [, secondScore]] = scoreCategories(text);

    let category = topScore >= 2 ? topCat : 'unknown';
    // Confidence grows with the score and with the lead over the runner-up.
    let confidence =
      category === 'unknown' ? 0.3 : Math.min(0.95, 0.5 + 0.1 * topScore + 0.1 * (topScore - secondScore));
    if (category !== 'unknown' && topScore - secondScore < 1) {
      confidence = Math.min(confidence, 0.5); // too close to call
    }

    const urgency = detectUrgency(text);
    const suggestedAction = DEFAULT_ACTION[category];
    const draft = DRAFTS[category];
    const summaryByCat: Record<string, string> = {
      customer_inquiry: 'Sender is asking for information about our product or service.',
      complaint: 'Sender is unhappy and is asking for help or a refund.',
      meeting_request: 'Sender wants to schedule a meeting or call.',
      job_opportunity: 'Sender is offering or asking about a job opportunity.',
      spam: 'Message looks like unsolicited or fraudulent bulk mail.',
      unknown: 'The message is too vague to determine what is being asked.',
    };

    return {
      category,
      confidence: Number(confidence.toFixed(2)),
      intent: {
        summary: summaryByCat[category],
        request: email.subject,
        requiredResponse:
          suggestedAction === 'draft_reply'
            ? 'Reply to the sender'
            : suggestedAction === 'flag_for_review'
              ? 'Human review before any response'
              : 'File under a category; no reply needed',
      },
      keyDetails: extractKeyDetails(email),
      urgency,
      suggestedAction,
      ...(suggestedAction === 'draft_reply' && draft ? { draftResponse: draft(email) } : {}),
      reasoning: `Matched ${category.replace('_', ' ')} keywords (score ${topScore}, confidence ${confidence.toFixed(2)}).`,
    };
  }
}

/** Human-readable rendering of a PipelineReport (plain console text). */
import { PipelineReport } from '../pipeline/pipeline';

/**
 * Strips ANSI 7-bit ESC sequences (CSI, OSC, and 2-byte Fe/Fp/Fs) and 8-bit C1 CSI sequences.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?|[@-Z\\-_])|\u009B[0-?]*[ -/]*[@-~]/g;

/**
 * Strips Unicode bidirectional control and override characters that could reorder terminal text.
 */
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Replaces line/paragraph breaks and tabs with a single space so untrusted fields cannot forge new terminal lines.
 */
const LINE_BREAK_OR_TAB_RE = /\r\n|[\r\n\t\u0085\u2028\u2029]/g;

/**
 * Strips remaining ASCII C0 control characters, DEL, and Unicode C1 control characters.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F\u0080-\u009F]/g;

/**
 * Sanitizes an untrusted string for single-line terminal display.
 * Handles CR/LF, ASCII control characters, ANSI escape sequences, Unicode C1 controls,
 * Unicode line/paragraph separators, and bidirectional control characters.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .replace(LINE_BREAK_OR_TAB_RE, ' ')
    .replace(CONTROL_CHAR_RE, '');
}

/**
 * Sanitizes a multi-line preview string into safe individual terminal lines.
 * Preserves intentional line breaks (`\n` / `\r\n`) while neutralizing bare `\r`,
 * Unicode line/paragraph separators, ANSI escapes, C0/C1 controls, and bidi controls inside each line.
 */
export function sanitizeTerminalMultiline(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((lineText) => sanitizeTerminalText(lineText));
}

const line = (label: string, value: string) => `  ${label.padEnd(16)} ${value}`;

export function formatReport(r: PipelineReport): string {
  const out: string[] = [];
  out.push('='.repeat(72));
  out.push(`EMAIL   ${sanitizeTerminalText(r.email.id)}  |  From: ${sanitizeTerminalText(r.email.from)}`);
  out.push(`SUBJECT ${sanitizeTerminalText(r.email.subject)}`);
  out.push('-'.repeat(72));

  out.push('1. CLASSIFICATION');
  if (r.triage) {
    out.push(line('Category:', `${r.triage.category}  (confidence ${r.triage.confidence})`));
    out.push(line('Urgency:', r.triage.urgency.toUpperCase()));
    out.push('2. EXTRACTED INTENT');
    out.push(line('Summary:', sanitizeTerminalText(r.triage.intent.summary)));
    out.push(line('Needs:', sanitizeTerminalText(r.triage.intent.requiredResponse)));
    out.push(line('Key details:', r.triage.keyDetails.map(sanitizeTerminalText).join(' | ')));
    out.push(line('Reasoning:', sanitizeTerminalText(r.triage.reasoning)));
  } else {
    out.push(line('Result:', `INVALID TRIAGE OUTPUT - ${sanitizeTerminalText(r.validationError ?? '')}`));
  }

  out.push('3. PROPOSED ACTION');
  out.push(line('Suggested:', r.proposedAction ?? '(none)'));

  out.push('4. POLICY DECISION');
  out.push(line('Verdict:', `[${r.policy.verdict.toUpperCase()}]`));
  for (const reason of r.policy.reasons) out.push(line('', `- ${sanitizeTerminalText(reason)}`));
  if (r.fallbackPolicy) {
    out.push(line('Fallback:', `${r.fallbackPolicy.action} -> [${r.fallbackPolicy.verdict.toUpperCase()}]`));
  }

  out.push('5. APPROVAL');
  out.push(line('Status:', `[${r.approval.toUpperCase()}]  ${sanitizeTerminalText(r.approvalNote)}`));

  out.push('6. EXECUTION  (SIMULATED - nothing real is sent or modified)');
  out.push(line('Action:', r.finalAction ?? '(none)'));
  out.push(line('Status:', `[${r.execution.status.toUpperCase()}]`));
  out.push(line('Detail:', sanitizeTerminalText(r.execution.detail)));
  return out.join('\n');
}

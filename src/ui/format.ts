/** Human-readable rendering of a PipelineReport (plain console text). */
import { PipelineReport } from '../pipeline/pipeline';

const line = (label: string, value: string) => `  ${label.padEnd(16)} ${value}`;

export function formatReport(r: PipelineReport): string {
  const out: string[] = [];
  out.push('='.repeat(72));
  out.push(`EMAIL   ${r.email.id}  |  From: ${r.email.from}`);
  out.push(`SUBJECT ${r.email.subject}`);
  out.push('-'.repeat(72));

  out.push('1. CLASSIFICATION');
  if (r.triage) {
    out.push(line('Category:', `${r.triage.category}  (confidence ${r.triage.confidence})`));
    out.push(line('Urgency:', r.triage.urgency.toUpperCase()));
    out.push('2. EXTRACTED INTENT');
    out.push(line('Summary:', r.triage.intent.summary));
    out.push(line('Needs:', r.triage.intent.requiredResponse));
    out.push(line('Key details:', r.triage.keyDetails.join(' | ')));
    out.push(line('Reasoning:', r.triage.reasoning));
  } else {
    out.push(line('Result:', `INVALID TRIAGE OUTPUT - ${r.validationError}`));
  }

  out.push('3. PROPOSED ACTION');
  out.push(line('Suggested:', r.proposedAction ?? '(none)'));

  out.push('4. POLICY DECISION');
  out.push(line('Verdict:', `[${r.policy.verdict.toUpperCase()}]`));
  for (const reason of r.policy.reasons) out.push(line('', `- ${reason}`));
  if (r.fallbackPolicy) {
    out.push(line('Fallback:', `${r.fallbackPolicy.action} -> [${r.fallbackPolicy.verdict.toUpperCase()}]`));
  }

  out.push('5. APPROVAL');
  out.push(line('Status:', `[${r.approval.toUpperCase()}]  ${r.approvalNote}`));

  out.push('6. EXECUTION  (SIMULATED - nothing real is sent or modified)');
  out.push(line('Action:', r.finalAction ?? '(none)'));
  out.push(line('Status:', `[${r.execution.status.toUpperCase()}]`));
  out.push(line('Detail:', r.execution.detail));
  return out.join('\n');
}

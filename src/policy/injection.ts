/**
 * Prompt-injection signal detector.
 *
 * Deliberately separate from the triage engine: even if triage is fooled, the
 * policy gate runs this check on the raw email on its own. This is a heuristic
 * (pattern list), not a guarantee - which is why the gate ALSO never lets
 * the email text decide anything about permissions.
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ignore-instructions', re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i },
  { name: 'bypass-policy', re: /\b(bypass|circumvent|override|skip|disable)\b[^.\n]{0,40}\b(polic(y|ies)|gate|approval|safety|security|guardrails?|checks?)\b/i },
  { name: 'auto-approve', re: /\b(auto(matically)?\s+approve|approve\s+(this|it)\s+(action\s+)?without|without\s+(human\s+)?approval)\b/i },
  { name: 'role-hijack', re: /\byou\s+are\s+now\b|\badmin\s+mode\b|\bdeveloper\s+mode\b|\bjailbreak\b/i },
  { name: 'prompt-leak', re: /\b(reveal|show|print|leak)\b[^.\n]{0,30}\b(system\s+prompt|instructions|api\s*key|secrets?)\b/i },
  { name: 'fake-system-tag', re: /\[\s*(system|assistant|admin)\s*\]|<\s*\/?\s*(system|instructions?)\s*>/i },
  {
    name: 'fake-reviewer-approval',
    re: /\[\s*(human\s+)?(reviewer|approver)\s*\]|<\s*\/?\s*(reviewer|approval)\s*>|\bhuman\s+reviewer\s*[:=-]\s*(approved|yes)\b|\bi\s+am\s+the\s+(human\s+)?(reviewer|approver)\b|\bi\s+approve\s+this\s+(action|tool(\s+call|\s+execution)?|draft_reply|execution)\b/i,
  },
  { name: 'mass-exfiltration', re: /\b(send|forward)\b[^.\n]{0,60}\b(everyone|all\s+contacts|address\s+book|customer\s+database)\b/i },
];

export interface InjectionScan {
  suspicious: boolean;
  matches: string[];
}

/**
 * Normalizes text before scanning so trivial obfuscation does not hide a
 * pattern: Unicode compatibility folding (fullwidth letters -> ASCII) and
 * removal of zero-width / invisible format characters. Look-alike letters from
 * other scripts and character-spacing tricks are NOT handled (known limit).
 */
function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
}

export function scanForInjection(subject: string, body: string): InjectionScan {
  const text = normalizeForScan(`${subject}\n${body}`);
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  return { suspicious: matches.length > 0, matches };
}

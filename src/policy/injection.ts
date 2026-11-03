/**
 * Prompt-injection signal detector.
 *
 * Deliberately separate from the triage engine: even if triage is fooled, the
 * policy gate runs this check on the raw email on its own. This is a heuristic
 * (pattern list), not a guarantee - which is why the gate ALSO never lets
 * the email text decide anything about permissions.
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ignore-instructions', re: /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i },
  { name: 'bypass-policy', re: /\b(bypass|circumvent|override|skip|disable)\b[^.\n]{0,40}\b(polic(y|ies)|gate|approval|safety|security|guardrails?|checks?)\b/i },
  { name: 'auto-approve', re: /\b(auto(matically)?\s+approve|approve\s+(this|it)\s+(action\s+)?without|without\s+(human\s+)?approval)\b/i },
  { name: 'role-hijack', re: /\byou\s+are\s+now\b|\badmin\s+mode\b|\bdeveloper\s+mode\b|\bjailbreak\b/i },
  { name: 'prompt-leak', re: /\b(reveal|show|print|leak)\b[^.\n]{0,30}\b(system\s+prompt|instructions|api\s*key|secrets?)\b/i },
  { name: 'fake-system-tag', re: /\[\s*(system|assistant|admin)\s*\]|<\s*\/?\s*(system|instructions?)\s*>/i },
  { name: 'mass-exfiltration', re: /\b(send|forward)\b[^.\n]{0,60}\b(everyone|all\s+contacts|address\s+book|customer\s+database)\b/i },
];

export interface InjectionScan {
  suspicious: boolean;
  matches: string[];
}

export function scanForInjection(subject: string, body: string): InjectionScan {
  const text = `${subject}\n${body}`;
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  return { suspicious: matches.length > 0, matches };
}

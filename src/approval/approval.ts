/**
 * Human approval step.
 *
 * `ApprovalProvider` is the only way approval can be granted. Anything other
 * than the exact string "approved" (rejection, junk value, thrown error,
 * timeout) is treated as NOT approved.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ActionType, Email } from '../types';
import { sanitizeTerminalMultiline, sanitizeTerminalText } from '../ui/format';

export interface ApprovalRequest {
  email: Email;
  action: ActionType;
  /** Text that would be sent/saved if approved. */
  preview: string;
}

export interface ApprovalProvider {
  request(req: ApprovalRequest): Promise<'approved' | 'rejected'>;
  /** Who is answering, for messages and audit text (e.g. "human reviewer", "static demo provider"). */
  readonly reviewerLabel?: string;
}

/** Normalizes any provider outcome into a safe boolean. */
export async function askForApproval(
  provider: ApprovalProvider,
  req: ApprovalRequest,
  timeoutMs = 120_000,
): Promise<{ status: 'approved' | 'rejected' | 'invalid'; note: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      provider.request(req),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('approval timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
    const who = provider.reviewerLabel ?? 'approval provider';
    if (answer === 'approved') return { status: 'approved', note: `Approved by ${who}.` };
    if (answer === 'rejected') return { status: 'rejected', note: `Rejected by ${who}.` };
    return { status: 'invalid', note: `Unexpected approval response: ${String(answer)}` };
  } catch (e) {
    return { status: 'invalid', note: `Approval failed: ${(e as Error).message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Interactive prompt for the CLI. */
export class CliApprovalProvider implements ApprovalProvider {
  readonly reviewerLabel = 'human reviewer';
  async request(req: ApprovalRequest): Promise<'approved' | 'rejected'> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log('\n  --- APPROVAL REQUIRED ---');
      console.log(`  Action : ${req.action}   (simulated - nothing is really sent)`);
      // Sanitize untrusted sender, subject, and preview lines so control/escape/bidi sequences cannot spoof terminal prompts.
      console.log(`  To     : ${sanitizeTerminalText(req.email.from)}`);
      console.log(`  Subject: ${sanitizeTerminalText(req.email.subject)}`);
      console.log('  Preview:');
      for (const line of sanitizeTerminalMultiline(req.preview)) console.log(`    | ${line}`);
      const a = (await rl.question('\n  Approve this action? (y/N): ')).trim().toLowerCase();
      return a === 'y' || a === 'yes' ? 'approved' : 'rejected';
    } finally {
      rl.close();
    }
  }
}

/** Non-interactive providers for tests and `--auto` demos. */
export class StaticApprovalProvider implements ApprovalProvider {
  /** A fixed, pre-programmed answer: this is NOT a human review. */
  readonly reviewerLabel = 'static demo provider';
  calls = 0;
  constructor(private readonly answer: 'approved' | 'rejected') {}
  async request(): Promise<'approved' | 'rejected'> {
    this.calls++;
    return this.answer;
  }
}

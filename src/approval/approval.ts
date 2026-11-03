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

export interface ApprovalRequest {
  email: Email;
  action: ActionType;
  /** Text that would be sent/saved if approved. */
  preview: string;
}

export interface ApprovalProvider {
  request(req: ApprovalRequest): Promise<'approved' | 'rejected'>;
}

/** Normalizes any provider outcome into a safe boolean. */
export async function askForApproval(
  provider: ApprovalProvider,
  req: ApprovalRequest,
  timeoutMs = 120_000,
): Promise<{ status: 'approved' | 'rejected' | 'invalid'; note: string }> {
  try {
    const answer = await Promise.race([
      provider.request(req),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('approval timed out')), timeoutMs).unref()),
    ]);
    if (answer === 'approved') return { status: 'approved', note: 'Approved by human reviewer.' };
    if (answer === 'rejected') return { status: 'rejected', note: 'Rejected by human reviewer.' };
    return { status: 'invalid', note: `Unexpected approval response: ${String(answer)}` };
  } catch (e) {
    return { status: 'invalid', note: `Approval failed: ${(e as Error).message}` };
  }
}

/** Interactive prompt for the CLI. */
export class CliApprovalProvider implements ApprovalProvider {
  async request(req: ApprovalRequest): Promise<'approved' | 'rejected'> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log('\n  --- APPROVAL REQUIRED ---');
      console.log(`  Action : ${req.action}   (simulated - nothing is really sent)`);
      console.log(`  To     : ${req.email.from}`);
      console.log('  Preview:');
      for (const line of req.preview.split('\n')) console.log(`    | ${line}`);
      const a = (await rl.question('\n  Approve this action? (y/N): ')).trim().toLowerCase();
      return a === 'y' || a === 'yes' ? 'approved' : 'rejected';
    } finally {
      rl.close();
    }
  }
}

/** Non-interactive providers for tests and `--auto` demos. */
export class StaticApprovalProvider implements ApprovalProvider {
  calls = 0;
  constructor(private readonly answer: 'approved' | 'rejected') {}
  async request(): Promise<'approved' | 'rejected'> {
    this.calls++;
    return this.answer;
  }
}

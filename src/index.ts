/**
 * CLI entry point.
 *
 *   npm start                   interactive menu (you approve/reject drafts)
 *   npm run demo                run all samples, auto-APPROVE approval requests
 *   npm run demo:reject         run all samples, auto-REJECT approval requests
 *
 * Everything is simulated. No email is ever sent.
 */
import 'reflect-metadata';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SAMPLE_EMAILS } from './email/samples';
import { EmailOperationsPipeline } from './pipeline/pipeline';
import { CliApprovalProvider, StaticApprovalProvider } from './approval/approval';
import { formatReport } from './ui/format';
import { Email } from './types';

async function runAll(answer: 'approved' | 'rejected') {
  const pipeline = new EmailOperationsPipeline({ approval: new StaticApprovalProvider(answer) });
  console.log(`\nDemo mode: every approval request is automatically ${answer.toUpperCase()}.`);
  for (const email of SAMPLE_EMAILS) {
    console.log('\n' + formatReport(await pipeline.process(email)));
  }
  console.log('\n' + '='.repeat(72));
  console.log(`Simulated outbox: ${pipeline.executor.simulatedOutbox.length} | Review queue: ${pipeline.executor.reviewQueue.length} | Labels: ${pipeline.executor.labels.length}`);
}

async function interactive() {
  const pipeline = new EmailOperationsPipeline({ approval: new CliApprovalProvider() });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      console.log('\nEmail Operations Agent  (all actions are SIMULATED)');
      SAMPLE_EMAILS.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${e.subject}`));
      console.log('  c. Enter a custom email');
      console.log('  q. Quit');
      const choice = (await rl.question('Select: ')).trim().toLowerCase();
      if (choice === 'q') break;
      let email: Email | undefined;
      if (choice === 'c') {
        const from = await rl.question('From: ');
        const subject = await rl.question('Subject: ');
        const body = await rl.question('Body (single line): ');
        email = { id: 'custom', from, subject, body };
      } else {
        email = SAMPLE_EMAILS[Number(choice) - 1];
      }
      if (!email) {
        console.log('Invalid selection.');
        continue;
      }
      // The approval prompt opens its own readline; pause ours meanwhile.
      rl.pause();
      console.log('\n' + formatReport(await pipeline.process(email)));
      rl.resume();
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--approve') return runAll('approved');
  if (arg === '--reject') return runAll('rejected');
  return interactive();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  },
);

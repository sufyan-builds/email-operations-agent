/**
 * Standalone CLI demonstration for HazelJS Autonomous Application Runtime (AAR).
 *
 *   npm run demo:autonomous
 *
 * Demonstrates:
 *   - `@Autonomous`, `@Observe`, `@Capability`, and `AutonomousRuntime`
 *   - `mode: 'approval-required'` and `simulation: true` hard safety barrier
 *   - Scenario 1: Customer inquiry -> proposed reply -> human APPROVES -> simulated completion
 *   - Scenario 2: Customer inquiry -> proposed reply -> human REJECTS -> run cancelled
 *   - Scenario 3: Prompt-injection email -> blocked by policy gate -> routed to review capability
 *   - Run history (`runtime.listRuns()`) and timeline inspection
 */
import 'reflect-metadata';
import { SAMPLE_EMAILS } from '../email/samples';
import {
  createAutonomousEmailRuntime,
  formatAutonomousScenario,
  runAutonomousEmailScenario,
} from './email-autonomous';

async function main(): Promise<void> {
  const { runtime, service } = await createAutonomousEmailRuntime();

  const inquiryEmail = SAMPLE_EMAILS.find((e) => e.id === 'inquiry-1')!;
  const injectionEmail = SAMPLE_EMAILS.find((e) => e.id === 'injection-1')!;

  console.log('\nHazelJS Autonomous Application Runtime (AAR) — Email Operations Demo');
  console.log('Safety Barrier: simulation=true (no real emails or live side effects can execute)\n');

  // Scenario 1: Human approves the proposed reply
  const approvedResult = await runAutonomousEmailScenario(runtime, inquiryEmail, {
    approved: true,
    actor: 'human-reviewer',
  });
  console.log(formatAutonomousScenario('1. Inquiry Email — Human APPROVES Reply', inquiryEmail, approvedResult));

  // Scenario 2: Human rejects the proposed reply
  const rejectedResult = await runAutonomousEmailScenario(runtime, inquiryEmail, {
    approved: false,
    actor: 'human-reviewer',
  });
  console.log('\n' + formatAutonomousScenario('2. Inquiry Email — Human REJECTS Reply', inquiryEmail, rejectedResult));

  // Scenario 3: Prompt-injection email blocked by policy gate -> routed to review
  const injectionResult = await runAutonomousEmailScenario(runtime, injectionEmail, {
    approved: true,
    actor: 'human-reviewer',
  });
  console.log(
    '\n' +
      formatAutonomousScenario(
        '3. Prompt Injection Email — Policy Gate Blocks Reply & Flags for Review',
        injectionEmail,
        injectionResult,
      ),
  );

  // Run History Summary
  const runs = await runtime.listRuns();
  console.log('\n' + '='.repeat(72));
  console.log(`AAR RUN HISTORY (${runs.length} runs recorded in MemoryAutonomousRunStore)`);
  console.log('-'.repeat(72));
  for (const r of runs) {
    console.log(
      `  Run ${r.id} | status=${r.status.padEnd(10)} | phase=${r.metadata.phase.padEnd(10)} | capability=${r.metadata.capabilityId} | dryRun=${r.metadata.dryRun}`,
    );
  }
  console.log(`Live capability method invocations: ${service.liveInvocations.length} (blocked by simulation: true barrier)`);
}

main().catch((err) => {
  console.error('Fatal error in autonomous demo:', err);
  process.exit(1);
});


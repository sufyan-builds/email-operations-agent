import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { getAutonomousMetadata, isAutonomous } from '@hazeljs/autonomous';
import { SAMPLE_EMAILS } from '../src/email/samples';
import {
  AutonomousEmailService,
  CAPABILITY_DRAFT_REPLY,
  CAPABILITY_FLAG_REVIEW,
  EMAIL_RECEIVED_EVENT,
  createAutonomousEmailRuntime,
  formatAutonomousScenario,
  runAutonomousEmailScenario,
} from '../src/autonomous/email-autonomous';

const sample = (id: string) => SAMPLE_EMAILS.find((e) => e.id === id)!;

describe('HazelJS Autonomous Application Runtime (AAR) — Email Operations', () => {
  it('registers @Autonomous, @Observe, and @Capability metadata on AutonomousEmailService', async () => {
    const { runtime } = await createAutonomousEmailRuntime();
    expect(isAutonomous(AutonomousEmailService)).toBe(true);

    const meta = getAutonomousMetadata(AutonomousEmailService);
    expect(meta?.options.id).toBe('email-operations-autonomous');
    expect(meta?.options.mode).toBe('approval-required');
    expect(meta?.options.capabilities).toEqual([CAPABILITY_DRAFT_REPLY, CAPABILITY_FLAG_REVIEW]);

    const registeredCaps = runtime.registry.listCapabilities().map((c) => c.id);
    expect(registeredCaps).toContain(CAPABILITY_DRAFT_REPLY);
    expect(registeredCaps).toContain(CAPABILITY_FLAG_REVIEW);
  });

  it('pauses at waiting_for_human (approval_pending) before any reply capability runs', async () => {
    const { runtime, service } = await createAutonomousEmailRuntime();
    const inquiry = sample('inquiry-1');

    const [runId] = await runtime.emit(EMAIL_RECEIVED_EVENT, inquiry, {
      source: 'test',
      subject: inquiry.id,
    });
    expect(runId).toBeTruthy();

    const run = await runtime.inspect(runId!);
    expect(run?.status).toBe('waiting_for_human');
    expect(run?.metadata.phase).toBe('approval_pending');
    expect(run?.metadata.capabilityId).toBe(CAPABILITY_DRAFT_REPLY);
    expect(run?.metadata.dryRun).toBe(true);
    expect(service.liveInvocations).toHaveLength(0);
  });

  it('approval path: resumes after human approval and completes under the simulation: true barrier', async () => {
    const { runtime, service } = await createAutonomousEmailRuntime();
    const inquiry = sample('inquiry-1');

    const result = await runAutonomousEmailScenario(runtime, inquiry, {
      approved: true,
      actor: 'human-reviewer',
    });

    expect(result.beforeApproval.status).toBe('waiting_for_human');
    expect(result.beforeApproval.metadata.phase).toBe('approval_pending');

    expect(result.afterResume.status).toBe('completed');
    expect(result.afterResume.metadata.phase).toBe('completed');
    expect(result.afterResume.metadata.effectStatus).toBe('succeeded');
    expect(result.afterResume.output).toMatchObject({
      simulated: true,
      capabilityId: CAPABILITY_DRAFT_REPLY,
      arguments: {
        emailId: 'inquiry-1',
        to: 'priya.sharma@example.com',
        subject: 'Re: Question about your premium plan pricing',
        category: 'customer_inquiry',
      },
    });

    const timelineTypes = result.timeline.map((e) => e.type);
    expect(timelineTypes).toContain('decision.started');
    expect(timelineTypes).toContain('approval.pending');
    expect(timelineTypes).toContain('capability.simulated');
    expect(timelineTypes).toContain('run.completed');

    // Hard simulation barrier: live method body was never invoked
    expect(service.liveInvocations).toHaveLength(0);
  });

  it('rejection path: cancels the run when the reviewer rejects approval and never executes', async () => {
    const { runtime, service } = await createAutonomousEmailRuntime();
    const inquiry = sample('inquiry-1');

    const result = await runAutonomousEmailScenario(runtime, inquiry, {
      approved: false,
      actor: 'human-reviewer',
    });

    expect(result.beforeApproval.status).toBe('waiting_for_human');
    expect(result.afterResume.status).toBe('cancelled');
    expect(result.afterResume.metadata.phase).toBe('cancelled');
    expect(result.afterResume.output).toBeUndefined();

    const timelineTypes = result.timeline.map((e) => e.type);
    expect(timelineTypes).toContain('approval.pending');
    expect(timelineTypes).toContain('run.cancelled');
    expect(timelineTypes).not.toContain('capability.simulated');
    expect(timelineTypes).not.toContain('capability.execution.completed');
    expect(service.liveInvocations).toHaveLength(0);
  });

  it('policy gate integration: blocks prompt-injection email from proposing draft_reply and routes to flag_for_review', async () => {
    const { runtime, service } = await createAutonomousEmailRuntime();
    const injection = sample('injection-1');

    const result = await runAutonomousEmailScenario(runtime, injection, {
      approved: true,
      actor: 'human-reviewer',
    });

    expect(result.beforeApproval.metadata.capabilityId).toBe(CAPABILITY_FLAG_REVIEW);
    expect(result.afterResume.status).toBe('completed');
    expect(result.afterResume.output).toMatchObject({
      simulated: true,
      capabilityId: CAPABILITY_FLAG_REVIEW,
      arguments: {
        emailId: 'injection-1',
        from: 'attacker@example.net',
      },
    });
    expect(service.liveInvocations).toHaveLength(0);
  });

  it('records run history across multiple runs and formats human-readable reports', async () => {
    const { runtime } = await createAutonomousEmailRuntime();
    const inquiry = sample('inquiry-1');

    const r1 = await runAutonomousEmailScenario(runtime, inquiry, { approved: true, actor: 'alice' });
    const r2 = await runAutonomousEmailScenario(runtime, inquiry, { approved: false, actor: 'bob' });

    const runs = await runtime.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status).sort()).toEqual(['cancelled', 'completed']);

    const formatted = formatAutonomousScenario('Test Label', inquiry, r1);
    expect(formatted).toContain('AAR SCENARIO: Test Label');
    expect(formatted).toContain('ENABLED (simulation: true)');
    expect(formatted).toContain('[capability.simulated]');
    expect(r2.afterResume.status).toBe('cancelled');
  });
});

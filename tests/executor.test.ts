import { describe, it, expect } from 'vitest';
import { ActionExecutor } from '../src/execution/action-executor';
import { Email, PolicyDecision } from '../src/types';

const email: Email = { id: 'e1', from: 'a@example.com', subject: 'Hi', body: 'Hello' };
const allow = (action: PolicyDecision['action']): PolicyDecision => ({ verdict: 'allow', action, reasons: ['ok'] });
const needsApproval: PolicyDecision = { verdict: 'require_approval', action: 'draft_reply', reasons: ['side effect'] };
const blocked: PolicyDecision = { verdict: 'block', action: 'draft_reply', reasons: ['no'], fallbackAction: 'flag_for_review' };

describe('ActionExecutor', () => {
  it('refuses to run with no authorization', () => {
    const ex = new ActionExecutor();
    expect(ex.execute('nope', 'flag_for_review').status).toBe('refused');
    expect(ex.reviewQueue).toHaveLength(0);
  });

  it('runs an allowed low-risk action (simulated)', () => {
    const ex = new ActionExecutor();
    ex.authorize('r1', email, allow('flag_for_review'));
    const r = ex.execute('r1', 'flag_for_review');
    expect(r.status).toBe('simulated_executed');
    expect(r.simulated).toBe(true);
    expect(ex.reviewQueue).toHaveLength(1);
  });

  it('cannot execute an approval-required action before approval', () => {
    const ex = new ActionExecutor();
    ex.authorize('r2', email, needsApproval, { draftText: 'Hello' });
    expect(ex.execute('r2', 'draft_reply').status).toBe('refused');
    expect(ex.simulatedOutbox).toHaveLength(0);
  });

  it('does not execute a rejected action or an invalid approval', () => {
    for (const status of ['rejected', 'invalid'] as const) {
      const ex = new ActionExecutor();
      ex.authorize('r3', email, needsApproval, { draftText: 'Hello' });
      ex.recordApproval('r3', status);
      expect(ex.execute('r3', 'draft_reply').status).toBe('refused');
      expect(ex.simulatedOutbox).toHaveLength(0);
    }
  });

  it('executes after explicit approval, exactly once', () => {
    const ex = new ActionExecutor();
    ex.authorize('r4', email, needsApproval, { draftText: 'Hello there' });
    ex.recordApproval('r4', 'approved');
    expect(ex.execute('r4', 'draft_reply').status).toBe('simulated_executed');
    expect(ex.simulatedOutbox[0].body).toBe('Hello there');
    expect(ex.execute('r4', 'draft_reply').status).toBe('refused'); // replay
    expect(ex.simulatedOutbox).toHaveLength(1);
  });

  it('refuses blocked decisions even if "approved"', () => {
    const ex = new ActionExecutor();
    ex.authorize('r5', email, blocked, { draftText: 'x' });
    ex.recordApproval('r5', 'approved');
    expect(ex.execute('r5', 'draft_reply').status).toBe('refused');
    expect(ex.simulatedOutbox).toHaveLength(0);
  });

  it('refuses an action different from the one authorized', () => {
    const ex = new ActionExecutor();
    ex.authorize('r6', email, allow('categorize'));
    expect(ex.execute('r6', 'draft_reply').status).toBe('refused');
    expect(ex.simulatedOutbox).toHaveLength(0);
  });

  it('fails safely when execution throws (draft without text)', () => {
    const ex = new ActionExecutor();
    ex.authorize('r7', email, needsApproval); // no draftText
    ex.recordApproval('r7', 'approved');
    expect(ex.execute('r7', 'draft_reply').status).toBe('failed');
  });
});

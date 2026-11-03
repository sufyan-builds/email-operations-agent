import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { getAgentTools, getToolMetadata } from '@hazeljs/agent';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  EmailOperationsPipeline,
  MAX_APPROVAL_TIMEOUT_MS,
  RUNTIME_APPROVAL_LIMIT_MS,
  parseApprovalEvent,
  resolveApprovalTimeoutMs,
} from '../src/pipeline/pipeline';
import { ApprovalProvider, ApprovalRequest, CliApprovalProvider, StaticApprovalProvider, askForApproval } from '../src/approval/approval';
import { EmailOpsAgent } from '../src/agent/email-ops-agent';
import { ACTION_RULES } from '../src/policy/policy-gate';
import { ACTION_TYPES, Email } from '../src/types';

const inquiry: Email = {
  id: 'inq',
  from: 'p@example.com',
  subject: 'Pricing question',
  body: 'How much does the premium plan cost? Do you offer support?',
};

describe('Fix 3: approval timeout is bounded below the HazelJS runtime limit', () => {
  it('keeps the existing default', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(120_000);
    expect(resolveApprovalTimeoutMs(undefined)).toBe(120_000);
  });

  it('passes values below the limit through unchanged', () => {
    expect(resolveApprovalTimeoutMs(100)).toBe(100);
    expect(resolveApprovalTimeoutMs(MAX_APPROVAL_TIMEOUT_MS - 1)).toBe(MAX_APPROVAL_TIMEOUT_MS - 1);
  });

  it('allows the maximum, which is strictly below the runtime limit', () => {
    expect(MAX_APPROVAL_TIMEOUT_MS).toBeLessThan(RUNTIME_APPROVAL_LIMIT_MS);
    expect(resolveApprovalTimeoutMs(MAX_APPROVAL_TIMEOUT_MS)).toBe(MAX_APPROVAL_TIMEOUT_MS);
  });

  it('caps values equal to or above the runtime limit', () => {
    expect(resolveApprovalTimeoutMs(RUNTIME_APPROVAL_LIMIT_MS)).toBe(MAX_APPROVAL_TIMEOUT_MS);
    expect(resolveApprovalTimeoutMs(RUNTIME_APPROVAL_LIMIT_MS + 1)).toBe(MAX_APPROVAL_TIMEOUT_MS);
    expect(resolveApprovalTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_APPROVAL_TIMEOUT_MS);
    expect(resolveApprovalTimeoutMs(Infinity)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });

  it.each([0, -5, NaN, -Infinity, '1000', null, {}])('falls back to the default for invalid value %s', (v) => {
    expect(resolveApprovalTimeoutMs(v)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });

  it('an over-limit pipeline option is capped, not rejected, and the pipeline still works', async () => {
    const reject: ApprovalProvider = { request: async () => 'rejected' };
    const pipeline = new EmailOperationsPipeline({ approval: reject, approvalTimeoutMs: 10 * RUNTIME_APPROVAL_LIMIT_MS });
    const r = await pipeline.process(inquiry);
    expect(r.approval).toBe('rejected');
    expect(pipeline.executor.simulatedOutbox).toHaveLength(0);
  });

  it('a timed-out approval is recorded as invalid and not executed', async () => {
    const hang: ApprovalProvider = { request: () => new Promise(() => undefined) };
    const pipeline = new EmailOperationsPipeline({ approval: hang, approvalTimeoutMs: 80 });
    const r = await pipeline.process(inquiry);
    expect(r.approval).toBe('invalid');
    expect(r.approvalNote).toMatch(/timed out/);
    expect(r.execution.status).not.toBe('simulated_executed');
    expect(pipeline.executor.simulatedOutbox).toHaveLength(0);
  });
});

describe('Fix 4: approval preview action comes from the event', () => {
  it('draft_reply behavior is preserved: provider sees draft_reply and the draft text', async () => {
    const seen: ApprovalRequest[] = [];
    const approval: ApprovalProvider = {
      request: async (req) => {
        seen.push(req);
        return 'rejected';
      },
    };
    const pipeline = new EmailOperationsPipeline({ approval, approvalTimeoutMs: 2000 });
    await pipeline.process(inquiry);
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe('draft_reply');
    expect(seen[0].preview).toMatch(/Thank you for your interest/);
  });

  it('parseApprovalEvent derives the action from toolName', () => {
    const ev = (toolName: unknown) => ({ data: { requestId: 'q1', toolName, input: { runId: 'r1' } } });
    expect(parseApprovalEvent(ev('draft_reply'))).toEqual({ requestId: 'q1', runId: 'r1', action: 'draft_reply' });
    // A different approval-required tool in future is shown as itself, not as draft_reply.
    expect(parseApprovalEvent(ev('categorize'))?.action).toBe('categorize');
  });

  it.each([
    ['undefined event', undefined],
    ['null event', null],
    ['no data', {}],
    ['data not an object', { data: 'x' }],
    ['no requestId', { data: { toolName: 'draft_reply', input: { runId: 'r' } } }],
    ['empty requestId', { data: { requestId: '', toolName: 'draft_reply', input: { runId: 'r' } } }],
    ['no runId', { data: { requestId: 'q', toolName: 'draft_reply', input: {} } }],
    ['null input', { data: { requestId: 'q', toolName: 'draft_reply', input: null } }],
    ['missing toolName', { data: { requestId: 'q', input: { runId: 'r' } } }],
    ['unknown toolName', { data: { requestId: 'q', toolName: 'delete_everything', input: { runId: 'r' } } }],
    ['non-string toolName', { data: { requestId: 'q', toolName: 7, input: { runId: 'r' } } }],
  ])('parseApprovalEvent returns null for %s', (_n, ev) => {
    expect(parseApprovalEvent(ev)).toBeNull();
  });
});

describe('Fix 5: policy ACTION_RULES and @Tool approval flags agree', () => {
  const toolNames = getAgentTools(EmailOpsAgent as never);
  const requiresApprovalOnTool = (name: string) =>
    getToolMetadata(EmailOpsAgent.prototype, name)?.requiresApproval === true;

  it('every action has a matching @Tool and vice versa', () => {
    expect([...toolNames].sort()).toEqual([...ACTION_TYPES].sort());
    expect(Object.keys(ACTION_RULES).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it.each([...ACTION_TYPES])('%s: policy requiresApproval equals @Tool requiresApproval', (action) => {
    expect(getToolMetadata(EmailOpsAgent.prototype, action)).toBeDefined();
    expect(requiresApprovalOnTool(action)).toBe(ACTION_RULES[action].requiresApproval);
  });
});

describe('approval wording reflects the actual provider', () => {
  const req = { email: inquiry, action: 'draft_reply' as const, preview: 'p' };

  it('static demo provider is not described as a human reviewer', async () => {
    const approved = await askForApproval(new StaticApprovalProvider('approved'), req, 1000);
    const rejected = await askForApproval(new StaticApprovalProvider('rejected'), req, 1000);
    expect(approved).toEqual({ status: 'approved', note: 'Approved by static demo provider.' });
    expect(rejected).toEqual({ status: 'rejected', note: 'Rejected by static demo provider.' });
  });

  it('CLI provider is labelled as a human reviewer; unlabelled providers get a neutral label', async () => {
    expect(new CliApprovalProvider().reviewerLabel).toBe('human reviewer');
    const plain: ApprovalProvider = { request: async () => 'approved' };
    expect((await askForApproval(plain, req, 1000)).note).toBe('Approved by approval provider.');
  });

  it('wording change does not alter behavior: status values are unchanged', async () => {
    const junk: ApprovalProvider = { request: async () => 'yes' as never };
    expect((await askForApproval(junk, req, 1000)).status).toBe('invalid');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  REQUISITION_JD_MAX_LENGTH,
  REQUISITION_TITLE_MAX_LENGTH,
  createRequisition,
  getAvailableStatusTransitions,
  getRequisition,
  isRequisitionEditable,
  isValidRequisitionRecord,
  listRequisitions,
  resolveRequisitionErrorMessage,
  transitionRequisitionStatus,
  updateRequisition,
  validateRequisitionInput,
} from './requisition.api.js';
import type { RequisitionRecord } from './types.js';
import {
  computeRequisitionSummaryCounts,
  filterRequisitions,
  sortRequisitionsByUpdatedAt,
} from './use-requisitions.js';

const SAMPLE_REQ_DRAFT: RequisitionRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientName: 'Apex Fintech',
  title: 'Senior Backend Engineer',
  jdText: 'Looking for a Senior Backend Engineer with TypeScript and PostgreSQL experience.',
  status: 'DRAFT',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-15T14:30:00.000Z',
};

const SAMPLE_REQ_OPEN: RequisitionRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  clientName: 'Beacon Health',
  title: 'Frontend React Lead',
  jdText: 'Lead our web platform using React 19, Tailwind CSS, and Vite.',
  status: 'OPEN',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-20T11:15:00.000Z',
};

const SAMPLE_REQ_PAUSED: RequisitionRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientName: 'Apex Fintech',
  title: 'DevOps Specialist',
  jdText: 'Kubernetes, Terraform, AWS.',
  status: 'PAUSED',
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

const SAMPLE_REQ_CLOSED: RequisitionRecord = {
  id: '44444444-4444-4444-8444-444444444444',
  clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  clientName: 'Cyberdyne AI',
  title: 'Machine Learning Engineer',
  jdText: 'PyTorch, transformers, inference optimization.',
  status: 'CLOSED',
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const SAMPLE_REQ_FILLED: RequisitionRecord = {
  id: '55555555-5555-4555-8555-555555555555',
  clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  clientName: 'Cyberdyne AI',
  title: 'Data Platform Architect',
  jdText: 'Snowflake, dbt, Apache Kafka.',
  status: 'FILLED',
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-09-15T08:00:00.000Z',
};

describe('requisition.api & domain helpers (M9.3 Step 3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. listRequisitions sends GET /requisitions and parses valid DTOs', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ requisitions: [SAMPLE_REQ_DRAFT, SAMPLE_REQ_OPEN] });

    const result = await listRequisitions();

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith('/requisitions', {});
    expect(result).toEqual([SAMPLE_REQ_DRAFT, SAMPLE_REQ_OPEN]);
  });

  it('2. listRequisitions rejects malformed server payloads with 502 invalid_response_format', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      requisitions: [{ id: 'bad-record', title: 'Missing fields' }],
    });

    await expect(listRequisitions()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('3. getRequisition encodes ID and returns valid RequisitionRecord', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ requisition: SAMPLE_REQ_DRAFT });

    const result = await getRequisition(SAMPLE_REQ_DRAFT.id);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(`/requisitions/${SAMPLE_REQ_DRAFT.id}`, {});
    expect(result).toEqual(SAMPLE_REQ_DRAFT);
  });

  it('4. getRequisition rejects empty requisitionId before network call', async () => {
    const getSpy = vi.spyOn(apiClient, 'get');

    await expect(getRequisition('   ')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('5. createRequisition validates input and sends POST /requisitions', async () => {
    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ requisition: SAMPLE_REQ_DRAFT });

    const created = await createRequisition({
      clientId: SAMPLE_REQ_DRAFT.clientId,
      title: '  Senior Backend Engineer  ',
      jdText: '  Looking for a Senior Backend Engineer...  ',
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/requisitions', {
      clientId: SAMPLE_REQ_DRAFT.clientId,
      title: 'Senior Backend Engineer',
      jdText: 'Looking for a Senior Backend Engineer...',
    });
    expect(created).toEqual(SAMPLE_REQ_DRAFT);
  });

  it('6. createRequisition enforces client-side validation rules', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');

    // Missing client
    await expect(
      createRequisition({ clientId: '', title: 'Eng', jdText: 'JD' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Select a client organization.',
    });

    // Invalid client UUID
    await expect(
      createRequisition({ clientId: 'not-a-uuid', title: 'Eng', jdText: 'JD' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'A valid client selection is required.',
    });

    // Empty title
    await expect(
      createRequisition({ clientId: SAMPLE_REQ_DRAFT.clientId, title: '  ', jdText: 'JD' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Enter a requisition job title.',
    });

    // Title exceeds max length
    await expect(
      createRequisition({
        clientId: SAMPLE_REQ_DRAFT.clientId,
        title: 'A'.repeat(REQUISITION_TITLE_MAX_LENGTH + 1),
        jdText: 'JD',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: `Title must be ${REQUISITION_TITLE_MAX_LENGTH} characters or fewer.`,
    });

    // Empty JD text
    await expect(
      createRequisition({
        clientId: SAMPLE_REQ_DRAFT.clientId,
        title: 'Eng',
        jdText: '   ',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Enter the job description requirements.',
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('7. updateRequisition sends PATCH /requisitions/:id with sanitized fields', async () => {
    const patchSpy = vi
      .spyOn(apiClient, 'patch')
      .mockResolvedValueOnce({ requisition: { ...SAMPLE_REQ_DRAFT, title: 'Staff Engineer' } });

    const updated = await updateRequisition(SAMPLE_REQ_DRAFT.id, {
      title: ' Staff Engineer ',
    });

    expect(patchSpy).toHaveBeenCalledWith(`/requisitions/${SAMPLE_REQ_DRAFT.id}`, {
      title: 'Staff Engineer',
    });
    expect(updated.title).toBe('Staff Engineer');
  });

  it('8. updateRequisition rejects empty update payload before network call', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch');

    await expect(updateRequisition(SAMPLE_REQ_DRAFT.id, {})).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('9. transitionRequisitionStatus sends POST /requisitions/:id/status with valid status', async () => {
    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ requisition: { ...SAMPLE_REQ_DRAFT, status: 'OPEN' } });

    const transitioned = await transitionRequisitionStatus(SAMPLE_REQ_DRAFT.id, 'OPEN');

    expect(postSpy).toHaveBeenCalledWith(`/requisitions/${SAMPLE_REQ_DRAFT.id}/status`, {
      status: 'OPEN',
    });
    expect(transitioned.status).toBe('OPEN');
  });

  it('10. resolveRequisitionErrorMessage handles scorecard requirement on DRAFT -> OPEN', () => {
    const badRequestError = new ApiError({
      status: 400,
      code: 'invalid_request',
      message: 'invalid_request',
    });

    const msg = resolveRequisitionErrorMessage(badRequestError, 'Default message', {
      action: 'transition',
      currentStatus: 'DRAFT',
      targetStatus: 'OPEN',
    });

    expect(msg).toBe(
      'This requisition cannot be opened yet because it requires an approved scorecard. Create and approve a scorecard before opening.',
    );
  });

  it('11. resolveRequisitionErrorMessage handles 404, 403, and network errors gracefully', () => {
    const notFound = new ApiError({ status: 404, code: 'not_found', message: 'Not found' });
    expect(resolveRequisitionErrorMessage(notFound, 'Default')).toBe(
      'The requested requisition or client could not be found in your organization.',
    );

    const forbidden = new ApiError({ status: 403, code: 'forbidden', message: 'Forbidden' });
    expect(resolveRequisitionErrorMessage(forbidden, 'Default')).toContain('permission');

    const network = new ApiError({ status: 0, code: 'network_error', message: 'Failed to fetch' });
    expect(resolveRequisitionErrorMessage(network, 'Default')).toContain('connection');
  });

  it('12. getAvailableStatusTransitions enforces the state machine accurately', () => {
    expect(getAvailableStatusTransitions('DRAFT')).toEqual(['OPEN']);
    expect(getAvailableStatusTransitions('OPEN')).toEqual(['PAUSED', 'CLOSED', 'FILLED']);
    expect(getAvailableStatusTransitions('PAUSED')).toEqual(['OPEN', 'CLOSED', 'FILLED']);
    expect(getAvailableStatusTransitions('CLOSED')).toEqual([]);
    expect(getAvailableStatusTransitions('FILLED')).toEqual([]);
  });

  it('13. isRequisitionEditable allows edit only for DRAFT', () => {
    expect(isRequisitionEditable('DRAFT')).toBe(true);
    expect(isRequisitionEditable('OPEN')).toBe(false);
    expect(isRequisitionEditable('PAUSED')).toBe(false);
    expect(isRequisitionEditable('CLOSED')).toBe(false);
    expect(isRequisitionEditable('FILLED')).toBe(false);
  });

  it('14. computeRequisitionSummaryCounts tallies statuses correctly', () => {
    const counts = computeRequisitionSummaryCounts([
      SAMPLE_REQ_DRAFT,
      SAMPLE_REQ_OPEN,
      SAMPLE_REQ_PAUSED,
      SAMPLE_REQ_CLOSED,
      SAMPLE_REQ_FILLED,
    ]);

    expect(counts).toEqual({
      total: 5,
      draft: 1,
      open: 1,
      paused: 1,
      closedOrFilled: 2,
    });
  });

  it('15. filterRequisitions filters by status and case-insensitive search', () => {
    const list = [
      SAMPLE_REQ_DRAFT,
      SAMPLE_REQ_OPEN,
      SAMPLE_REQ_PAUSED,
      SAMPLE_REQ_CLOSED,
      SAMPLE_REQ_FILLED,
    ];

    // Status filter DRAFT
    expect(filterRequisitions(list, 'DRAFT', '')).toEqual([SAMPLE_REQ_DRAFT]);

    // Status filter CLOSED_OR_FILLED
    expect(filterRequisitions(list, 'CLOSED_OR_FILLED', '')).toEqual([
      SAMPLE_REQ_CLOSED,
      SAMPLE_REQ_FILLED,
    ]);

    // Search query matches title
    expect(filterRequisitions(list, 'ALL', 'backend')).toEqual([SAMPLE_REQ_DRAFT]);

    // Search query matches client name
    expect(filterRequisitions(list, 'ALL', 'cyberdyne')).toEqual([
      SAMPLE_REQ_CLOSED,
      SAMPLE_REQ_FILLED,
    ]);

    // Combined filter
    expect(filterRequisitions(list, 'OPEN', 'cyberdyne')).toEqual([]);
  });

  it('16. sortRequisitionsByUpdatedAt sorts descending by updatedAt', () => {
    const sorted = sortRequisitionsByUpdatedAt([
      SAMPLE_REQ_DRAFT, // Oct 15
      SAMPLE_REQ_OPEN, // Oct 20
      SAMPLE_REQ_PAUSED, // Oct 18
    ]);

    expect(sorted.map((r) => r.id)).toEqual([
      SAMPLE_REQ_OPEN.id, // Oct 20
      SAMPLE_REQ_PAUSED.id, // Oct 18
      SAMPLE_REQ_DRAFT.id, // Oct 15
    ]);
  });

  it('17. isValidRequisitionRecord validates shape and required fields', () => {
    expect(isValidRequisitionRecord(SAMPLE_REQ_DRAFT)).toBe(true);
    expect(isValidRequisitionRecord({ id: '123' })).toBe(false);
    expect(isValidRequisitionRecord(null)).toBe(false);
  });

  it('18. validateRequisitionInput enforces lengths and valid client UUID format', () => {
    const res = validateRequisitionInput(
      { clientId: SAMPLE_REQ_DRAFT.clientId, title: 'Title', jdText: 'JD' },
      'create',
    );
    expect(res.valid).toBe(true);
    expect(res.sanitized.title).toBe('Title');

    const longJd = 'A'.repeat(REQUISITION_JD_MAX_LENGTH + 1);
    const invalidRes = validateRequisitionInput(
      { clientId: SAMPLE_REQ_DRAFT.clientId, title: 'Title', jdText: longJd },
      'create',
    );
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.errors.jdText).toContain('Job description must be');
  });
});

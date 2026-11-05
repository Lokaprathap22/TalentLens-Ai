import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  CLIENT_NAME_MAX_LENGTH,
  DUPLICATE_CLIENT_NAME_MESSAGE,
  createClient,
  listClients,
  resolveClientErrorMessage,
  updateClient,
  validateClientName,
} from './client.api.js';
import type { ClientRecord } from './types.js';
import { computeClientSummaryCounts, filterClients, sortClientsByName } from './use-clients.js';

const SAMPLE_CLIENT_ACTIVE: ClientRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Apex Fintech',
  status: 'ACTIVE',
  createdAt: '2026-10-12T09:00:00.000Z',
  updatedAt: '2026-10-15T14:30:00.000Z',
};

const SAMPLE_CLIENT_INACTIVE: ClientRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Beacon Health',
  status: 'INACTIVE',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-20T11:15:00.000Z',
};

describe('client.api & client domain helpers (M9.3 Step 2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. listClients requests GET /clients?includeInactive=true and parses valid client DTOs', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ clients: [SAMPLE_CLIENT_ACTIVE, SAMPLE_CLIENT_INACTIVE] });

    const result = await listClients();

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith('/clients?includeInactive=true', {});
    expect(result).toEqual([SAMPLE_CLIENT_ACTIVE, SAMPLE_CLIENT_INACTIVE]);
  });

  it('2. listClients rejects malformed server payloads with 502 invalid_response_format', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      clients: [{ id: 'bad-record', name: 'Missing fields' }],
    });

    await expect(listClients()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('3. createClient trims the name and sends POST /clients with { name }', async () => {
    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ client: SAMPLE_CLIENT_ACTIVE });

    const created = await createClient({ name: '   Apex Fintech   ' });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/clients', { name: 'Apex Fintech' });
    expect(created).toEqual(SAMPLE_CLIENT_ACTIVE);
  });

  it('4. createClient rejects empty, whitespace-only, or >200-character names before network call', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');

    await expect(createClient({ name: '   ' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'Enter a client name.',
    });

    await expect(
      createClient({ name: 'A'.repeat(CLIENT_NAME_MAX_LENGTH + 1) }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: `Client name must be ${CLIENT_NAME_MAX_LENGTH} characters or fewer.`,
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('5. updateClient sends PATCH /clients/:clientId with trimmed name payload', async () => {
    const updatedRecord: ClientRecord = {
      ...SAMPLE_CLIENT_ACTIVE,
      name: 'Apex Global Fintech',
      updatedAt: '2026-11-05T10:00:00.000Z',
    };
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({ client: updatedRecord });

    const result = await updateClient(SAMPLE_CLIENT_ACTIVE.id, {
      name: '  Apex Global Fintech  ',
    });

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(`/clients/${SAMPLE_CLIENT_ACTIVE.id}`, {
      name: 'Apex Global Fintech',
    });
    expect(result).toEqual(updatedRecord);
  });

  it('6. updateClient sends PATCH /clients/:clientId with status payload for deactivate and reactivate', async () => {
    const deactivatedRecord: ClientRecord = {
      ...SAMPLE_CLIENT_ACTIVE,
      status: 'INACTIVE',
    };
    const reactivatedRecord: ClientRecord = {
      ...SAMPLE_CLIENT_ACTIVE,
      status: 'ACTIVE',
    };
    const patchSpy = vi
      .spyOn(apiClient, 'patch')
      .mockResolvedValueOnce({ client: deactivatedRecord })
      .mockResolvedValueOnce({ client: reactivatedRecord });

    const deactivated = await updateClient(SAMPLE_CLIENT_ACTIVE.id, { status: 'INACTIVE' });
    expect(patchSpy).toHaveBeenNthCalledWith(1, `/clients/${SAMPLE_CLIENT_ACTIVE.id}`, {
      status: 'INACTIVE',
    });
    expect(deactivated.status).toBe('INACTIVE');

    const reactivated = await updateClient(SAMPLE_CLIENT_ACTIVE.id, { status: 'ACTIVE' });
    expect(patchSpy).toHaveBeenNthCalledWith(2, `/clients/${SAMPLE_CLIENT_ACTIVE.id}`, {
      status: 'ACTIVE',
    });
    expect(reactivated.status).toBe('ACTIVE');
  });

  it('7. propagates ApiError instances and maps status codes to safe user-facing messages', async () => {
    const conflictError = new ApiError({
      status: 409,
      code: 'conflict',
      message: 'Conflict',
    });
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(conflictError);

    await expect(createClient({ name: 'Apex Fintech' })).rejects.toBe(conflictError);
    expect(resolveClientErrorMessage(conflictError, 'Fallback')).toBe(
      DUPLICATE_CLIENT_NAME_MESSAGE,
    );

    expect(
      resolveClientErrorMessage(
        new ApiError({ status: 404, code: 'not_found', message: 'Not found' }),
        'Fallback',
      ),
    ).toMatch(/could not be found in your organization/i);

    expect(
      resolveClientErrorMessage(
        new ApiError({ status: 403, code: 'forbidden', message: 'Forbidden' }),
        'Fallback',
      ),
    ).toMatch(/do not have permission/i);

    expect(
      resolveClientErrorMessage(
        new ApiError({ status: 0, code: 'network_error', message: 'Offline' }),
        'Fallback',
      ),
    ).toMatch(/Unable to reach TalentLens AI/i);

    expect(
      resolveClientErrorMessage(
        new ApiError({ status: 503, code: 'service_unavailable', message: 'Down' }),
        'Fallback',
      ),
    ).toMatch(/temporarily unavailable/i);
  });

  it('8. validateClientName, computeClientSummaryCounts, filterClients, and sortClientsByName work deterministically', () => {
    expect(validateClientName('  Northwind  ')).toEqual({ valid: true, name: 'Northwind' });
    expect(validateClientName('   ')).toEqual({ valid: false, error: 'Enter a client name.' });

    const counts = computeClientSummaryCounts([
      SAMPLE_CLIENT_ACTIVE,
      SAMPLE_CLIENT_INACTIVE,
      { ...SAMPLE_CLIENT_ACTIVE, id: '33333333-3333-4333-8333-333333333333', name: 'Citadel' },
    ]);
    expect(counts).toEqual({ total: 3, active: 2, inactive: 1 });

    const list = [SAMPLE_CLIENT_INACTIVE, SAMPLE_CLIENT_ACTIVE];
    expect(sortClientsByName(list).map((c) => c.name)).toEqual(['Apex Fintech', 'Beacon Health']);

    expect(filterClients(list, 'ALL', '').length).toBe(2);
    expect(filterClients(list, 'ACTIVE', '').map((c) => c.name)).toEqual(['Apex Fintech']);
    expect(filterClients(list, 'INACTIVE', '').map((c) => c.name)).toEqual(['Beacon Health']);
    expect(filterClients(list, 'ALL', '  beacon ')).toEqual([SAMPLE_CLIENT_INACTIVE]);
  });
});

import type { Logger, RetryConfig } from '@scottluskcis/octokit-harness';
import type { Octokit } from 'octokit';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuditLogPhrase,
  fetchRepoRenameEntries,
  nextAuditLogCursor,
  parseRepoRenameEntries,
  validateDateRange,
  validatePageSize,
} from '../../src/commands/list-audit-log-repo-renames.js';

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const retryConfig: RetryConfig = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffFactor: 1,
};

describe('audit log date range', () => {
  it('builds an inclusive action query with optional bounds', () => {
    const range = validateDateRange({
      startDate: '2026-01-02',
      endDate: '2026-02-03',
    });

    expect(buildAuditLogPhrase(range)).toBe(
      'action:repo.rename created:>=2026-01-02 created:<=2026-02-03',
    );
    expect(buildAuditLogPhrase({})).toBe('action:repo.rename');
  });

  it('rejects invalid and reversed dates', () => {
    expect(() => validateDateRange({ startDate: '2026-02-30' })).toThrow(
      'valid calendar date',
    );
    expect(() =>
      validateDateRange({
        startDate: '2026-02-02',
        endDate: '2026-02-01',
      }),
    ).toThrow('on or before');
  });
});

describe('audit log page size', () => {
  it('normalizes the shared string default', () => {
    expect(validatePageSize('10')).toBe(10);
  });

  it('rejects invalid page sizes', () => {
    expect(() => validatePageSize('1.5')).toThrow('integer from 1 to 100');
    expect(() => validatePageSize(101)).toThrow('integer from 1 to 100');
  });
});

describe('audit log pagination', () => {
  it('extracts the next cursor from a link header', () => {
    expect(
      nextAuditLogCursor(
        '<https://api.github.test/orgs/acme/audit-log?before=old>; rel="prev", <https://api.github.test/orgs/acme/audit-log?after=next-123>; rel="next"',
      ),
    ).toBe('next-123');
  });

  it('fetches every cursor page without a live API', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ action: 'repo.rename', repo: 'acme/new-one' }],
        headers: {
          link: '<https://api.github.test/orgs/acme/audit-log?after=cursor-2>; rel="next"',
        },
      })
      .mockResolvedValueOnce({
        data: [{ action: 'repo.rename', repo: 'acme/new-two' }],
        headers: {},
      });

    const entries = await fetchRepoRenameEntries({
      octokit: { request } as unknown as Octokit,
      organization: 'acme',
      phrase: 'action:repo.rename',
      perPage: 100,
      retryConfig,
      retryDisabled: true,
      logger: logger(),
    });

    expect(entries).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toMatchObject({ after: 'cursor-2' });
  });
});

describe('repository rename transformation', () => {
  it('normalizes timestamps, qualifies old names, skips malformed rows, and deduplicates', () => {
    const complete = {
      action: 'repo.rename',
      actor: 'octocat',
      created_at: 1_767_225_600_000,
      old_name: 'old-name',
      repo: 'acme/new-name',
    };

    expect(
      parseRepoRenameEntries([
        complete,
        { ...complete },
        { action: 'repo.create', repo: 'acme/ignored' },
        { action: 'repo.rename', actor: 'octocat' },
      ]),
    ).toEqual({
      records: [
        {
          renamed_at: '2026-01-01T00:00:00.000Z',
          original_repository_name: 'acme/old-name',
          new_repository_name: 'acme/new-name',
          actor: 'octocat',
        },
      ],
      skipped: 1,
    });
  });
});

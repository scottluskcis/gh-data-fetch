import type { Logger, RetryConfig } from '@scottluskcis/octokit-harness';
import { describe, expect, it, vi } from 'vitest';
import { resolveRequestedRepositoryNames } from '../../src/commands/set-org-repo-custom-property.js';
import { executeApiOperation } from '../../src/utils/api-operation.js';

const retryConfig: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffFactor: 1,
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('executeApiOperation', () => {
  it('retries only the supplied operation', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('completed');
    const logger = createLogger();

    await expect(
      executeApiOperation(
        operation,
        retryConfig,
        false,
        logger,
        'Updating batch',
      ),
    ).resolves.toBe('completed');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not retry when retries are disabled', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('failure'));

    await expect(
      executeApiOperation(
        operation,
        retryConfig,
        true,
        createLogger(),
        'Updating batch',
      ),
    ).rejects.toThrow('failure');

    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('resolveRequestedRepositoryNames', () => {
  it('uses canonical repository names returned by GitHub', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { name: 'lgcy-weams-vbaweams-3-0-12' } })
      .mockResolvedValueOnce({ data: { name: 'Another-Repo' } });

    await expect(
      resolveRequestedRepositoryNames(
        { rest: { repos: { get } } },
        'department-of-veterans-affairs',
        ['lgcy-weams-VBAWEAMS-3-0-12', 'another-repo'],
      ),
    ).resolves.toEqual(['lgcy-weams-vbaweams-3-0-12', 'Another-Repo']);

    expect(get).toHaveBeenCalledWith({
      owner: 'department-of-veterans-affairs',
      repo: 'lgcy-weams-VBAWEAMS-3-0-12',
    });
  });

  it('reports all missing repositories', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const get = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ data: { name: 'exists' } })
      .mockRejectedValueOnce(notFound);

    await expect(
      resolveRequestedRepositoryNames(
        { rest: { repos: { get } } },
        'acme',
        ['missing-one', 'exists', 'missing-two'],
      ),
    ).rejects.toThrow(
      'Repositories not found in acme: missing-one, missing-two',
    );
  });
});

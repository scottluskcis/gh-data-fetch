import type { Logger, RetryConfig } from '@scottluskcis/octokit-harness';
import { describe, expect, it, vi } from 'vitest';
import { executeApiOperation } from '../../src/commands/set-org-repo-custom-property.js';

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

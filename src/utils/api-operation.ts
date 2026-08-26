import {
  type Logger,
  type RetryConfig,
  withRetry,
} from '@scottluskcis/octokit-harness';

export async function executeApiOperation<T>(
  operation: () => Promise<T>,
  retryConfig: RetryConfig,
  retryDisabled: boolean,
  logger: Logger,
  description: string,
): Promise<T> {
  if (retryDisabled) {
    return operation();
  }

  return withRetry(operation, retryConfig, (state) => {
    logger.warn(
      `${description} failed (attempt ${state.attempt}); retrying: ${state.error?.message ?? 'Unknown error'}`,
    );
  });
}

import { describe, expect, it } from 'vitest';
import {
  collectOption,
  parseBooleanOption,
  retryConfigFromOptions,
} from '../../src/commands/command-helpers.js';

describe('command helpers', () => {
  it('collects repeated option values', () => {
    expect(collectOption('beta', ['alpha'])).toEqual(['alpha', 'beta']);
  });

  it('parses explicit boolean environment values', () => {
    expect(parseBooleanOption('true')).toBe(true);
    expect(parseBooleanOption('false')).toBe(false);
  });

  it('rejects ambiguous boolean values', () => {
    expect(() => parseBooleanOption('yes')).toThrow(
      'Expected "true" or "false"',
    );
  });

  it('creates retry configuration from command options', () => {
    expect(
      retryConfigFromOptions({
        retryMaxAttempts: 4,
        retryInitialDelay: 200,
        retryMaxDelay: 5000,
        retryBackoffFactor: 1.5,
        retrySuccessThreshold: 7,
      }),
    ).toEqual({
      maxAttempts: 4,
      initialDelayMs: 200,
      maxDelayMs: 5000,
      backoffFactor: 1.5,
      successThreshold: 7,
    });
  });
});

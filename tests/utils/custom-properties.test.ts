import { describe, expect, it } from 'vitest';
import {
  chunkRepositoryNames,
  parseBooleanOption,
  parseRepositoryList,
  resolveCustomPropertyValue,
  selectRepositoryNames,
} from '../../src/utils/custom-properties.js';

describe('parseBooleanOption', () => {
  it('parses explicit boolean environment values', () => {
    expect(parseBooleanOption('true')).toBe(true);
    expect(parseBooleanOption('false')).toBe(false);
  });

  it('rejects ambiguous boolean values', () => {
    expect(() => parseBooleanOption('yes')).toThrow(
      'Expected "true" or "false"',
    );
  });
});

describe('resolveCustomPropertyValue', () => {
  it('returns a string value', () => {
    expect(resolveCustomPropertyValue('production', false)).toBe('production');
  });

  it('returns null when clearing the property', () => {
    expect(resolveCustomPropertyValue(undefined, true)).toBeNull();
  });

  it('requires exactly one value mode', () => {
    expect(() => resolveCustomPropertyValue(undefined, false)).toThrow(
      'Specify exactly one',
    );
    expect(() => resolveCustomPropertyValue('production', true)).toThrow(
      'Specify exactly one',
    );
  });
});

describe('parseRepositoryList', () => {
  it('parses, trims, and de-duplicates repositories for the organization', () => {
    expect(
      parseRepositoryList('acme/one\n\n ACME/two \nacme/ONE\n', 'acme'),
    ).toEqual(['one', 'two']);
  });

  it('rejects malformed entries and repositories from another organization', () => {
    expect(() => parseRepositoryList('one', 'acme')).toThrow(
      'expected owner/repository',
    );
    expect(() => parseRepositoryList('other/one', 'acme')).toThrow(
      'belongs to other',
    );
  });
});

describe('selectRepositoryNames', () => {
  it('returns all repositories when no filter is supplied', () => {
    expect(selectRepositoryNames(['one', 'two'])).toEqual(['one', 'two']);
  });

  it('uses canonical names and rejects missing repositories', () => {
    expect(selectRepositoryNames(['One', 'Two'], ['one'])).toEqual(['One']);
    expect(() => selectRepositoryNames(['One'], ['missing'])).toThrow(
      'Repositories not found',
    );
  });
});

describe('chunkRepositoryNames', () => {
  it('limits batches to 30 repositories by default', () => {
    const repositories = Array.from(
      { length: 31 },
      (_, index) => `repo-${index}`,
    );

    expect(
      chunkRepositoryNames(repositories).map((batch) => batch.length),
    ).toEqual([30, 1]);
  });
});

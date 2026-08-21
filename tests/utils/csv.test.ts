import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../../src/utils/csv.js';

describe('parseCsvRecords', () => {
  it('parses headers, quoted values, whitespace, and a byte order mark', () => {
    expect(
      parseCsvRecords(
        '\uFEFForganization_login,description\n acme ,"Example, Inc."\n',
      ),
    ).toEqual([
      {
        organization_login: 'acme',
        description: 'Example, Inc.',
      },
    ]);
  });

  it('skips empty lines', () => {
    expect(parseCsvRecords('name\n\nalpha\n\nbeta\n')).toEqual([
      { name: 'alpha' },
      { name: 'beta' },
    ]);
  });
});

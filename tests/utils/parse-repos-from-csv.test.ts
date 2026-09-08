import { describe, expect, it, vi } from 'vitest';
import {
  extractRepoLines,
  renderRepoCsv,
} from '../../src/utils/parse-repos-from-csv.js';

describe('extractRepoLines', () => {
  it('joins the org and repo column values using the delimiter', () => {
    const contents = 'source_org,repo_name\nacme,widgets\nacme,gadgets\n';

    expect(
      extractRepoLines(contents, {
        orgColumn: 'source_org',
        repoColumn: 'repo_name',
        delimiter: '/',
      }),
    ).toEqual(['acme/widgets', 'acme/gadgets']);
  });

  it('supports a custom delimiter', () => {
    const contents = 'org,repo\nacme,widgets\n';

    expect(
      extractRepoLines(contents, {
        orgColumn: 'org',
        repoColumn: 'repo',
        delimiter: '|',
      }),
    ).toEqual(['acme|widgets']);
  });

  it('throws when a requested column is missing from the source CSV', () => {
    const contents = 'org,repo\nacme,widgets\n';

    expect(() =>
      extractRepoLines(contents, {
        orgColumn: 'missing_column',
        repoColumn: 'repo',
        delimiter: '/',
      }),
    ).toThrow(/missing_column/);
  });

  it('skips rows missing an org or repo value and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contents = 'org,repo\nacme,widgets\n,gadgets\nacme,\n';

    expect(
      extractRepoLines(contents, {
        orgColumn: 'org',
        repoColumn: 'repo',
        delimiter: '/',
      }),
    ).toEqual(['acme/widgets']);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('returns an empty array for a CSV with only a header row', () => {
    expect(
      extractRepoLines('org,repo\n', {
        orgColumn: 'org',
        repoColumn: 'repo',
        delimiter: '/',
      }),
    ).toEqual([]);
  });
});

describe('renderRepoCsv', () => {
  it('renders lines without a header by default', () => {
    expect(
      renderRepoCsv(['acme/widgets', 'acme/gadgets'], {
        orgColumn: 'org',
        repoColumn: 'repo',
        delimiter: '/',
        includeHeader: false,
      }),
    ).toBe('acme/widgets\nacme/gadgets\n');
  });

  it('prefixes a header row built from the column names when requested', () => {
    expect(
      renderRepoCsv(['acme/widgets'], {
        orgColumn: 'source_org',
        repoColumn: 'repo_name',
        delimiter: '/',
        includeHeader: true,
      }),
    ).toBe('source_org/repo_name\nacme/widgets\n');
  });

  it('returns an empty string when there are no lines and no header', () => {
    expect(
      renderRepoCsv([], {
        orgColumn: 'org',
        repoColumn: 'repo',
        delimiter: '/',
        includeHeader: false,
      }),
    ).toBe('');
  });
});

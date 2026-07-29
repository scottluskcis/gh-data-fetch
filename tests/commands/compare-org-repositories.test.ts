import type { Octokit } from 'octokit';
import { describe, expect, it, vi } from 'vitest';
import {
  findComparisonRepositories,
  parseOrganizationUrl,
} from '../../src/commands/compare-org-repositories.js';

function createOctokit(
  pages: object[][],
  error?: Error,
): {
  octokit: Octokit;
  iterator: ReturnType<typeof vi.fn>;
  listForOrg: ReturnType<typeof vi.fn>;
} {
  const listForOrg = vi.fn();
  const iterator = vi.fn(() =>
    (async function* () {
      for (const data of pages) {
        yield { data };
      }
      if (error) {
        throw error;
      }
    })(),
  );
  const octokit = {
    paginate: { iterator },
    rest: { repos: { listForOrg } },
  } as unknown as Octokit;

  return { octokit, iterator, listForOrg };
}

describe('parseOrganizationUrl', () => {
  it('parses and normalizes an HTTPS organization URL', () => {
    expect(parseOrganizationUrl('https://github.com/example/')).toEqual({
      name: 'example',
      url: 'https://github.com/example',
    });
  });

  it('rejects malformed URLs', () => {
    expect(() => parseOrganizationUrl('not a URL')).toThrow(
      'Invalid organization URL',
    );
  });

  it('rejects non-HTTPS URLs', () => {
    expect(() => parseOrganizationUrl('http://github.com/example')).toThrow(
      'Organization URL must use HTTPS',
    );
  });

  it('rejects URLs with unsupported components or paths', () => {
    expect(() =>
      parseOrganizationUrl('https://github.com/example?tab=repositories'),
    ).toThrow('Organization URL must not include');
    expect(() =>
      parseOrganizationUrl('https://github.com/example/repository'),
    ).toThrow('exactly one organization path segment');
  });
});

describe('findComparisonRepositories', () => {
  it('lists all pages once and indexes repositories case-insensitively', async () => {
    const alpha = { name: 'Alpha' };
    const beta = { name: 'beta' };
    const { octokit, iterator, listForOrg } = createOctokit([[alpha], [beta]]);

    const repositories = await findComparisonRepositories(octokit, 'example');

    expect(iterator).toHaveBeenCalledOnce();
    expect(iterator).toHaveBeenCalledWith(listForOrg, {
      org: 'example',
      per_page: 100,
      type: 'all',
    });
    expect(repositories.get('alpha')).toBe(alpha);
    expect(repositories.get('beta')).toBe(beta);
  });

  it.each([404, 500])('propagates API status %i errors', async (status) => {
    const { octokit } = createOctokit(
      [],
      Object.assign(new Error('API failure'), { status }),
    );

    await expect(
      findComparisonRepositories(octokit, 'example'),
    ).rejects.toMatchObject({ status });
  });
});

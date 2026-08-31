import type { Octokit } from 'octokit';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchOrgReposWithOpenAlerts,
  hasOpenSecretScanningAlerts,
} from '../../src/api/secret-scanning/secret-scanning-alerts.js';

function octokitWith(overrides: {
  listAlertsForRepo?: ReturnType<typeof vi.fn>;
  listAlertsForOrg?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    rest: {
      secretScanning: {
        listAlertsForRepo: overrides.listAlertsForRepo ?? vi.fn(),
        listAlertsForOrg: overrides.listAlertsForOrg ?? vi.fn(),
      },
    },
  } as unknown as Octokit;
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('hasOpenSecretScanningAlerts', () => {
  it('reports open alerts when the repository has at least one', async () => {
    const listAlertsForRepo = vi.fn().mockResolvedValue({ data: [{ id: 1 }] });
    await expect(
      hasOpenSecretScanningAlerts({
        octokit: octokitWith({ listAlertsForRepo }),
        owner: 'acme',
        repo: 'one',
      }),
    ).resolves.toEqual({ status: 'ok', hasOpenAlerts: true });
    expect(listAlertsForRepo).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'one',
      state: 'open',
      per_page: 1,
    });
  });

  it('reports no open alerts for an empty response', async () => {
    await expect(
      hasOpenSecretScanningAlerts({
        octokit: octokitWith({
          listAlertsForRepo: vi.fn().mockResolvedValue({ data: [] }),
        }),
        owner: 'acme',
        repo: 'one',
      }),
    ).resolves.toEqual({ status: 'ok', hasOpenAlerts: false });
  });

  it('treats a 404 as no open alerts', async () => {
    await expect(
      hasOpenSecretScanningAlerts({
        octokit: octokitWith({
          listAlertsForRepo: vi.fn().mockRejectedValue(httpError(404)),
        }),
        owner: 'acme',
        repo: 'one',
      }),
    ).resolves.toEqual({ status: 'ok', hasOpenAlerts: false });
  });

  it('reports other failures as unavailable rather than throwing', async () => {
    const result = await hasOpenSecretScanningAlerts({
      octokit: octokitWith({
        listAlertsForRepo: vi.fn().mockRejectedValue(httpError(500)),
      }),
      owner: 'acme',
      repo: 'one',
    });
    expect(result.status).toBe('unavailable');
    expect(result).toMatchObject({
      message: expect.stringContaining('acme/one'),
    });
  });
});

describe('fetchOrgReposWithOpenAlerts', () => {
  it('collects lowercased repository full names across pages', async () => {
    const listAlertsForOrg = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { repository: { full_name: 'Acme/One' } },
          { repository: { full_name: 'acme/one' } },
        ],
      })
      .mockResolvedValueOnce({
        data: [{ repository: { full_name: 'acme/two' } }],
      });

    const result = await fetchOrgReposWithOpenAlerts({
      octokit: octokitWith({ listAlertsForOrg }),
      org: 'acme',
      per_page: 2,
    });

    expect(result).toEqual({
      status: 'ok',
      repositoryFullNames: new Set(['acme/one', 'acme/two']),
    });
    expect(listAlertsForOrg).toHaveBeenCalledTimes(2);
    expect(listAlertsForOrg).toHaveBeenLastCalledWith({
      org: 'acme',
      state: 'open',
      per_page: 2,
      page: 2,
    });
  });

  it('reports unavailable when the organization endpoint fails', async () => {
    const result = await fetchOrgReposWithOpenAlerts({
      octokit: octokitWith({
        listAlertsForOrg: vi.fn().mockRejectedValue(httpError(403)),
      }),
      org: 'acme',
    });
    expect(result.status).toBe('unavailable');
  });
});

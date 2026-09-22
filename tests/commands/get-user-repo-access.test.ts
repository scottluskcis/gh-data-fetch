import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  Logger,
  OctokitExecutionContext,
} from '@scottluskcis/octokit-harness';
import type { Octokit } from 'octokit';
import { afterEach, vi } from 'vitest';

const { executeWithOctokitMock } = vi.hoisted(() => ({
  executeWithOctokitMock: vi.fn(),
}));

vi.mock('@scottluskcis/octokit-harness', async () => {
  const actual = await vi.importActual<
    typeof import('@scottluskcis/octokit-harness')
  >('@scottluskcis/octokit-harness');
  return { ...actual, executeWithOctokit: executeWithOctokitMock };
});

import {
  deriveEffectiveAccess,
  getCachedTeamMembership,
  parseRepositoryNames,
  renderAccessCsv,
  renderAccessMarkdown,
  type RepositoryAccessResult,
} from '../../src/commands/get-user-repo-access.js';

const getUserRepoAccessCommand = (
  await import('../../src/commands/get-user-repo-access.js')
).default;

const temporaryDirectories: string[] = [];

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function setupHarness(request: ReturnType<typeof vi.fn>): void {
  executeWithOctokitMock.mockImplementation(
    async (
      _options: unknown,
      callback: (context: OctokitExecutionContext) => Promise<unknown>,
    ) =>
      callback({
        octokit: { request } as unknown as Octokit,
        logger: logger(),
        opts: {} as OctokitExecutionContext['opts'],
      }),
  );
}

afterEach(() => {
  executeWithOctokitMock.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const result: RepositoryAccessResult = {
  organization: 'acme',
  repository: 'widgets',
  username: 'octocat',
  status: 'success',
  hasAccess: 'yes',
  effectivePermission: 'write',
  role: 'contributor',
  routes: ['team:developers (push)', 'direct collaborator (write)'],
  attributionComplete: true,
  error: '',
};

describe('get-user-repo-access command helpers', () => {
  it('parses comma-separated and file repository names', () => {
    expect(
      parseRepositoryNames(
        'acme',
        'widgets, acme/api,widgets',
        'acme/docs\nportal\n',
      ),
    ).toEqual(['widgets', 'api', 'docs', 'portal']);
  });

  it('rejects repositories from another organization', () => {
    expect(() => parseRepositoryNames('acme', 'other/widgets')).toThrow(
      'expected a repository name or acme/repository',
    );
  });

  it('requires at least one repository', () => {
    expect(() => parseRepositoryNames('acme')).toThrow(
      'Specify repositories with --repos or --repo-list',
    );
  });

  it('renders access routes and custom roles as CSV', () => {
    const csv = renderAccessCsv([result]);
    expect(csv).toContain('effective_permission,role,access_routes');
    expect(csv).toContain(
      'write,contributor,team:developers (push); direct collaborator (write)',
    );
  });

  it('renders explicit no-access results as Markdown', () => {
    const markdown = renderAccessMarkdown([
      {
        ...result,
        hasAccess: 'no',
        effectivePermission: 'none',
        role: 'none',
        routes: ['none'],
      },
    ]);
    expect(markdown).toContain(
      '| acme | widgets | octocat | success | no | none | none | none | yes |',
    );
  });

  it('escapes Markdown table delimiters in errors', () => {
    const markdown = renderAccessMarkdown([
      { ...result, status: 'error', error: 'first | second' },
    ]);
    expect(markdown).toContain('first \\| second');
  });

  it('derives read access from public repository visibility', () => {
    expect(
      deriveEffectiveAccess({
        collaboratorPermission: 'none',
        repositoryPrivate: false,
        organizationMember: false,
        organizationBasePermission: 'none',
      }),
    ).toEqual({
      hasAccess: 'yes',
      permission: 'read',
      role: 'read',
      routes: ['public repository'],
    });
  });

  it('derives access from the organization base permission', () => {
    expect(
      deriveEffectiveAccess({
        collaboratorPermission: 'none',
        repositoryPrivate: true,
        organizationMember: true,
        organizationBasePermission: 'write',
      }),
    ).toEqual({
      hasAccess: 'yes',
      permission: 'write',
      role: 'write',
      routes: ['organization base permission (write)'],
    });
  });

  it('reports unknown access when organization membership cannot be determined', () => {
    expect(
      deriveEffectiveAccess({
        collaboratorPermission: 'none',
        repositoryPrivate: true,
        organizationMember: undefined,
        organizationBasePermission: undefined,
      }),
    ).toEqual({
      hasAccess: 'unknown',
      permission: 'unknown',
      role: 'unknown',
      routes: ['unknown'],
    });
  });

  it('caches team membership by case-insensitive team slug', async () => {
    const cache = new Map();
    let requests = 0;
    const fetchMembership = async () => {
      requests++;
      return { active: true, complete: true };
    };

    await getCachedTeamMembership(cache, 'Developers', fetchMembership);
    await getCachedTeamMembership(cache, 'developers', fetchMembership);

    expect(requests).toBe(1);
  });

  it('runs the command workflow and reports direct and team routes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-access-'));
    temporaryDirectories.push(directory);
    const outputFile = path.join(directory, 'access.csv');
    const request = vi.fn((route: string) => {
      if (route === 'GET /users/{username}') {
        return Promise.resolve({ data: { login: 'octocat' } });
      }
      if (route === 'GET /orgs/{org}/memberships/{username}') {
        return Promise.resolve({ data: { state: 'active' } });
      }
      if (route === 'GET /orgs/{org}') {
        return Promise.resolve({
          data: { default_repository_permission: 'read' },
        });
      }
      if (route === 'GET /repos/{owner}/{repo}') {
        return Promise.resolve({ data: { private: true } });
      }
      if (
        route ===
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission'
      ) {
        return Promise.resolve({
          data: {
            permission: 'write',
            user: { role_name: 'contributor' },
          },
        });
      }
      if (route === 'GET /repos/{owner}/{repo}/collaborators') {
        return Promise.resolve({
          data: [{ login: 'octocat', role_name: 'write' }],
        });
      }
      if (route === 'GET /repos/{owner}/{repo}/teams') {
        return Promise.resolve({
          data: [{ slug: 'developers', permission: 'push' }],
        });
      }
      if (
        route === 'GET /orgs/{org}/teams/{team_slug}/memberships/{username}'
      ) {
        return Promise.resolve({ data: { state: 'active' } });
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    setupHarness(request);

    await getUserRepoAccessCommand.parseAsync([
      'node',
      'get-user-repo-access',
      '--org-name',
      'acme',
      '--username',
      'octocat',
      '--repos',
      'widgets',
      '--output-file',
      outputFile,
      '--retry-disabled',
      'true',
    ]);

    const output = fs.readFileSync(outputFile, 'utf8');
    expect(output).toContain('yes,write,contributor');
    expect(output).toContain(
      'direct collaborator (write); team:developers (push)',
    );
    expect(request).toHaveBeenCalledWith(
      'GET /orgs/{org}/teams/{team_slug}/memberships/{username}',
      expect.objectContaining({ team_slug: 'developers' }),
    );
  });

  it('keeps access while marking attribution incomplete after lookup failures', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-access-'));
    temporaryDirectories.push(directory);
    const outputFile = path.join(directory, 'access.csv');
    const request = vi.fn((route: string) => {
      if (route === 'GET /users/{username}') {
        return Promise.resolve({ data: { login: 'octocat' } });
      }
      if (route === 'GET /orgs/{org}/memberships/{username}') {
        return Promise.reject(
          Object.assign(new Error('forbidden'), { status: 403 }),
        );
      }
      if (route === 'GET /repos/{owner}/{repo}') {
        return Promise.resolve({ data: { private: true } });
      }
      if (
        route ===
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission'
      ) {
        return Promise.resolve({
          data: { permission: 'write', user: { role_name: 'write' } },
        });
      }
      if (route === 'GET /repos/{owner}/{repo}/collaborators') {
        return Promise.resolve({ data: [] });
      }
      if (route === 'GET /repos/{owner}/{repo}/teams') {
        return Promise.resolve({
          data: [{ slug: 'developers', permission: 'push' }],
        });
      }
      if (
        route === 'GET /orgs/{org}/teams/{team_slug}/memberships/{username}'
      ) {
        return Promise.reject(
          Object.assign(new Error('forbidden'), { status: 403 }),
        );
      }
      throw new Error(`Unexpected route: ${route}`);
    });
    setupHarness(request);

    await getUserRepoAccessCommand.parseAsync([
      'node',
      'get-user-repo-access',
      '--org-name',
      'acme',
      '--username',
      'octocat',
      '--repos',
      'widgets',
      '--output-file',
      outputFile,
      '--retry-disabled',
      'true',
    ]);

    const records = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
    expect(records[1]).toContain('yes,write,write');
    expect(records[1]).toContain(',no,');
  });
});

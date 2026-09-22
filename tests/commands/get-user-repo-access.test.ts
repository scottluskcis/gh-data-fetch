import { describe, expect, it } from 'vitest';
import {
  deriveEffectiveAccess,
  getCachedTeamMembership,
  parseRepositoryNames,
  renderAccessCsv,
  renderAccessMarkdown,
  type RepositoryAccessResult,
} from '../../src/commands/get-user-repo-access.js';

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
      hasAccess: true,
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
      hasAccess: true,
      permission: 'write',
      role: 'write',
      routes: ['organization base permission (write)'],
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
});

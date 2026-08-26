import { describe, expect, it } from 'vitest';
import {
  AUDIT_NOTES,
  buildAuditRecords,
  collectTargetRepoList,
  deriveMarkdownPath,
  parseAuditSourceExport,
  parseAuditTargetExport,
  renderAuditCsv,
  renderAuditMarkdown,
  stripArchiveSuffix,
  summarizeAuditRecords,
  targetRoleLabel,
  toAuditCsvRecord,
  type AuditSourceRepo,
  type AuditTargetRepo,
} from '../../src/utils/audit-repos.js';

const SOURCE_HEADERS =
  'organization_login,repository_name,repository_url,migration_status,migration_issue,is_locked';
const TARGET_HEADERS =
  'organization_login,repository_name,repository_url,visibility,archived,created_at,migration_issue';

function sourceCsv(rows: string[]): string {
  return [SOURCE_HEADERS, ...rows].join('\n') + '\n';
}

function targetCsv(rows: string[]): string {
  return [TARGET_HEADERS, ...rows].join('\n') + '\n';
}

describe('parseAuditSourceExport', () => {
  it('parses rows and preserves audit columns', () => {
    const result = parseAuditSourceExport(
      sourceCsv([
        'acme,one,https://github.com/acme/one,success,123,true',
        'acme,two,https://github.com/acme/two,not-started,,false',
      ]),
      'source',
    );
    expect(result.organization).toBe('acme');
    expect(result.repositories).toEqual([
      {
        organization: 'acme',
        repositoryName: 'one',
        url: 'https://github.com/acme/one',
        migrationStatus: 'success',
        migrationIssue: '123',
        isLocked: true,
      },
      {
        organization: 'acme',
        repositoryName: 'two',
        url: 'https://github.com/acme/two',
        migrationStatus: 'not-started',
        migrationIssue: '',
        isLocked: false,
      },
    ]);
  });

  it('preserves an unknown/blank is_locked value as undefined rather than false', () => {
    const result = parseAuditSourceExport(
      sourceCsv(['acme,one,https://github.com/acme/one,success,123,']),
      'source',
    );
    expect(result.repositories[0].isLocked).toBeUndefined();
  });

  it('requires required headers', () => {
    expect(() =>
      parseAuditSourceExport('organization_login,repository_name\nacme,one\n', 'source'),
    ).toThrow('missing required column');
  });

  it('rejects an empty file', () => {
    expect(() => parseAuditSourceExport(sourceCsv([]), 'source')).toThrow(
      'does not contain any repository rows',
    );
  });

  it('rejects multiple organizations in a single export', () => {
    expect(() =>
      parseAuditSourceExport(
        sourceCsv([
          'acme,one,https://github.com/acme/one,success,123,true',
          'other,two,https://github.com/other/two,success,124,true',
        ]),
        'source',
      ),
    ).toThrow('single organization_login value');
  });

  it('rejects duplicate repository names (case-insensitive)', () => {
    expect(() =>
      parseAuditSourceExport(
        sourceCsv([
          'acme,One,https://github.com/acme/one,success,123,true',
          'acme,one,https://github.com/acme/one,success,123,true',
        ]),
        'source',
      ),
    ).toThrow('duplicate repository name');
  });
});

describe('parseAuditTargetExport', () => {
  it('parses target rows including migration_issue when present', () => {
    const result = parseAuditTargetExport(
      targetCsv([
        'acme-software,one,https://github.com/acme-software/one,public,false,2024-01-01T00:00:00Z,123',
      ]),
      'software target',
    );
    expect(result.organization).toBe('acme-software');
    expect(result.repositories[0].migrationIssue).toBe('123');
  });
});

describe('collectTargetRepoList', () => {
  it('parses role=path entries', () => {
    expect(collectTargetRepoList('software=./software.csv', [])).toEqual([
      { role: 'software', path: './software.csv' },
    ]);
  });

  it('rejects an invalid role', () => {
    expect(() => collectTargetRepoList('bogus=./file.csv', [])).toThrow(
      'Invalid --target-repo-list role',
    );
  });

  it('rejects a missing path', () => {
    expect(() => collectTargetRepoList('software=', [])).toThrow(
      'missing a file path',
    );
  });

  it('rejects malformed values without an =', () => {
    expect(() => collectTargetRepoList('software', [])).toThrow(
      'expected format role=path',
    );
  });

  it('rejects a duplicate role', () => {
    expect(() =>
      collectTargetRepoList('software=./other.csv', [
        { role: 'software', path: './software.csv' },
      ]),
    ).toThrow('specified more than once');
  });
});

describe('stripArchiveSuffix', () => {
  it('strips a case-insensitive terminal suffix', () => {
    expect(stripArchiveSuffix('foo-DOVA', '-dova')).toBe('foo');
    expect(stripArchiveSuffix('foo-dova', '-DOVA')).toBe('foo');
  });

  it('returns null when the suffix is not a terminal match', () => {
    expect(stripArchiveSuffix('foo-dova-bar', '-dova')).toBeNull();
    expect(stripArchiveSuffix('foo', '-dova')).toBeNull();
  });
});

function sourceRepo(overrides: Partial<AuditSourceRepo> = {}): AuditSourceRepo {
  return {
    organization: 'acme',
    repositoryName: 'one',
    url: 'https://github.com/acme/one',
    migrationStatus: 'success',
    migrationIssue: '123',
    isLocked: false,
    ...overrides,
  };
}

function targetRepo(overrides: Partial<AuditTargetRepo> = {}): AuditTargetRepo {
  return {
    organization: 'acme-software',
    repositoryName: 'one',
    url: 'https://github.com/acme-software/one',
    visibility: 'private',
    archived: false,
    createdAt: '2024-01-01T00:00:00Z',
    migrationIssue: '123',
    ...overrides,
  };
}

describe('buildAuditRecords', () => {
  it('matches a repo found only in the software target', () => {
    const records = buildAuditRecords([sourceRepo()], {
      software: [targetRepo()],
    });
    expect(records[0].matches).toEqual([
      {
        role: 'software',
        organization: 'acme-software',
        repositoryName: 'one',
        url: 'https://github.com/acme-software/one',
        visibility: 'private',
        archived: false,
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);
    expect(targetRoleLabel(records[0].matches)).toBe('software');
    expect(records[0].notes).toEqual([]);
  });

  it('matches a repo found only in the archive target after suffix stripping', () => {
    const records = buildAuditRecords(
      [sourceRepo()],
      {
        archive: [
          targetRepo({
            organization: 'acme-archive',
            repositoryName: 'one-dova',
            url: 'https://github.com/acme-archive/one-dova',
          }),
        ],
      },
      { archiveSuffix: '-dova' },
    );
    expect(targetRoleLabel(records[0].matches)).toBe('archive');
    expect(records[0].matches[0].repositoryName).toBe('one-dova');
  });

  it('combines both matches with a matched-in-both-orgs note', () => {
    const records = buildAuditRecords(
      [sourceRepo()],
      {
        software: [targetRepo()],
        archive: [
          targetRepo({
            organization: 'acme-archive',
            repositoryName: 'one-dova',
          }),
        ],
      },
      { archiveSuffix: '-dova' },
    );
    expect(targetRoleLabel(records[0].matches)).toBe('both');
    expect(records[0].matches.map((match) => match.role)).toEqual([
      'software',
      'archive',
    ]);
    expect(records[0].notes).toContain(AUDIT_NOTES.MATCHED_BOTH);
  });

  it('flags status=success with no match as an anomaly', () => {
    const records = buildAuditRecords([sourceRepo({ migrationStatus: 'success' })], {});
    expect(records[0].notes).toEqual([AUDIT_NOTES.SUCCESS_NO_MATCH]);
  });

  it('does not flag a pending status with no match', () => {
    for (const status of ['not-started', 'in-progress', 'failure']) {
      const records = buildAuditRecords([sourceRepo({ migrationStatus: status })], {});
      expect(records[0].notes).toEqual([]);
    }
  });

  it('flags a migration_issue mismatch against the software target', () => {
    const records = buildAuditRecords(
      [sourceRepo({ migrationIssue: '123' })],
      { software: [targetRepo({ migrationIssue: '999' })] },
    );
    expect(records[0].notes).toContain(AUDIT_NOTES.ISSUE_MISMATCH);
  });

  it('does not flag a mismatch when either issue value is blank', () => {
    const records = buildAuditRecords(
      [sourceRepo({ migrationIssue: '' })],
      { software: [targetRepo({ migrationIssue: '999' })] },
    );
    expect(records[0].notes).not.toContain(AUDIT_NOTES.ISSUE_MISMATCH);
  });

  it('matches names case-insensitively', () => {
    const records = buildAuditRecords(
      [sourceRepo({ repositoryName: 'One' })],
      { software: [targetRepo({ repositoryName: 'ONE' })] },
    );
    expect(targetRoleLabel(records[0].matches)).toBe('software');
  });

  it('requires --archive-suffix when an archive target is provided', () => {
    expect(() =>
      buildAuditRecords([sourceRepo()], {
        archive: [targetRepo({ repositoryName: 'one-dova' })],
      }),
    ).toThrow('--archive-suffix is required');
  });

  it('rejects a suffix-only archive repository name', () => {
    expect(() =>
      buildAuditRecords(
        [sourceRepo()],
        { archive: [targetRepo({ repositoryName: '-dova' })] },
        { archiveSuffix: '-dova' },
      ),
    ).toThrow('cannot determine the source repository name');
  });

  it('warns and prefers the suffixed archive repository when names collide', () => {
    const warnings: string[] = [];
    const reverseWarnings: string[] = [];
    const records = buildAuditRecords(
      [sourceRepo()],
      {
        archive: [
          targetRepo({ repositoryName: 'one' }),
          targetRepo({ repositoryName: 'one-dova' }),
        ],
      },
      {
        archiveSuffix: '-dova',
        onWarning: (message) => warnings.push(message),
      },
    );
    const reverseRecords = buildAuditRecords(
      [sourceRepo()],
      {
        archive: [
          targetRepo({ repositoryName: 'one-dova' }),
          targetRepo({ repositoryName: 'one' }),
        ],
      },
      {
        archiveSuffix: '-dova',
        onWarning: (message) => reverseWarnings.push(message),
      },
    );

    expect(records[0].matches[0].repositoryName).toBe('one-dova');
    expect(reverseRecords[0].matches[0].repositoryName).toBe('one-dova');
    expect(warnings).toEqual([
      expect.stringContaining(
        'duplicate archive target repository name after normalization: "one"; using "one-dova" and ignoring "one"',
      ),
    ]);
    expect(reverseWarnings).toEqual(warnings);
  });
});

describe('toAuditCsvRecord', () => {
  it('joins both-match fields with a slash and sanitizes formula-leading values', () => {
    const records = buildAuditRecords(
      [sourceRepo({ repositoryName: '=cmd' })],
      {
        software: [targetRepo({ repositoryName: '=cmd' })],
        archive: [targetRepo({ organization: 'acme-archive', repositoryName: '=cmd-dova' })],
      },
      { archiveSuffix: '-dova' },
    );
    const row = toAuditCsvRecord(records[0]);
    expect(row.repo_name).toBe("'=cmd");
    expect(row.migrated_to_org).toBe('acme-software/acme-archive');
    expect(row.target_org).toBe('both');
  });
});

describe('summarizeAuditRecords', () => {
  it('counts each repo once for status and target label', () => {
    const records = buildAuditRecords(
      [
        sourceRepo({ repositoryName: 'one' }),
        sourceRepo({ repositoryName: 'two', migrationStatus: 'not-started' }),
      ],
      { software: [targetRepo({ repositoryName: 'one' })] },
    );
    const summary = summarizeAuditRecords(records);
    expect(summary.totalRepos).toBe(2);
    expect(summary.byStatus).toEqual({ success: 1, 'not-started': 1 });
    expect(summary.byTargetLabel).toEqual({ software: 1, none: 1 });
    expect(summary.anomalyCount).toBe(0);
  });
});

describe('deriveMarkdownPath', () => {
  it('derives a .md path from a .csv path', () => {
    expect(deriveMarkdownPath('/tmp/audit.csv')).toBe('/tmp/audit.md');
  });

  it('rejects a path that would collide with itself', () => {
    expect(() => deriveMarkdownPath('/tmp/audit.md')).toThrow(
      'distinct Markdown report path',
    );
  });
});

describe('renderAuditCsv and renderAuditMarkdown', () => {
  it('renders a CSV header and one row per record', () => {
    const records = buildAuditRecords([sourceRepo()], {
      software: [targetRepo()],
    });
    const csv = renderAuditCsv(records);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('repo_name');
  });

  it('renders a Markdown report with a summary and grouped details sections', () => {
    const records = buildAuditRecords([sourceRepo()], {
      software: [targetRepo()],
    });
    const summary = summarizeAuditRecords(records);
    const markdown = renderAuditMarkdown(records, summary, {
      migrationIssueUrlPrefix: 'https://github.com/acme/one/issues/',
    });
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('<details>');
    expect(markdown).toContain('[#123](https://github.com/acme/one/issues/123)');
    expect(markdown).toContain('[one](https://github.com/acme/one)');
  });
});

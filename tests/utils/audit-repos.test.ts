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
      parseAuditSourceExport(
        'organization_login,repository_name\nacme,one\n',
        'source',
      ),
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

  it('canonicalizes duplicate repository names and preserves every occurrence', () => {
    const result = parseAuditSourceExport(
      sourceCsv([
        'acme,One,https://github.com/acme/one,success,123,true',
        'acme, one ,https://github.com/acme/one-copy,failure,999,false',
      ]),
      'source',
    );

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({
      repositoryName: 'One',
      migrationStatus: 'success',
    });
    expect(result.duplicateGroups).toEqual([
      {
        normalizedName: 'one',
        occurrences: [
          expect.objectContaining({
            repositoryName: 'One',
            migrationStatus: 'success',
          }),
          expect.objectContaining({
            repositoryName: 'one',
            migrationStatus: 'failure',
          }),
        ],
      },
    ]);
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

  it('canonicalizes target duplicates and retains conflicting rows', () => {
    const result = parseAuditTargetExport(
      targetCsv([
        'acme-software,One,https://github.com/acme-software/one,private,false,2024-01-01T00:00:00Z,123',
        'acme-software,one,https://github.com/acme-software/one-copy,public,true,2024-02-01T00:00:00Z,999',
      ]),
      'software target',
    );

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({
      repositoryName: 'One',
      visibility: 'private',
    });
    expect(result.duplicateGroups[0]).toMatchObject({
      normalizedName: 'one',
      occurrences: [{ visibility: 'private' }, { visibility: 'public' }],
    });
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
    const records = buildAuditRecords(
      [sourceRepo({ migrationStatus: 'success' })],
      {},
    );
    expect(records[0].notes).toEqual([AUDIT_NOTES.SUCCESS_NO_MATCH]);
  });

  it('does not flag a pending status with no match', () => {
    for (const status of ['not-started', 'in-progress', 'failure']) {
      const records = buildAuditRecords(
        [sourceRepo({ migrationStatus: status })],
        {},
      );
      expect(records[0].notes).toEqual([]);
    }
  });

  it('flags a migration_issue mismatch against the software target', () => {
    const records = buildAuditRecords([sourceRepo({ migrationIssue: '123' })], {
      software: [targetRepo({ migrationIssue: '999' })],
    });
    expect(records[0].notes).toContain(AUDIT_NOTES.ISSUE_MISMATCH);
  });

  it('does not flag a mismatch when either issue value is blank', () => {
    const records = buildAuditRecords([sourceRepo({ migrationIssue: '' })], {
      software: [targetRepo({ migrationIssue: '999' })],
    });
    expect(records[0].notes).not.toContain(AUDIT_NOTES.ISSUE_MISMATCH);
  });

  it('matches names case-insensitively', () => {
    const records = buildAuditRecords([sourceRepo({ repositoryName: 'One' })], {
      software: [targetRepo({ repositoryName: 'ONE' })],
    });
    expect(targetRoleLabel(records[0].matches)).toBe('software');
  });

  it('adds duplicate anomaly notes to the canonical audit record', () => {
    const sourceDuplicate = {
      normalizedName: 'one',
      occurrences: [sourceRepo(), sourceRepo({ migrationStatus: 'failure' })],
    };
    const targetDuplicate = {
      normalizedName: 'one',
      occurrences: [targetRepo(), targetRepo({ visibility: 'public' })],
    };
    const records = buildAuditRecords(
      [sourceDuplicate.occurrences[0]],
      { software: [targetDuplicate.occurrences[0]] },
      {
        sourceDuplicateGroups: [sourceDuplicate],
        targetDuplicateGroups: { software: [targetDuplicate] },
      },
    );

    expect(records[0].notes).toEqual([
      AUDIT_NOTES.DUPLICATE_SOURCE,
      AUDIT_NOTES.DUPLICATE_SOFTWARE_TARGET,
    ]);
  });

  it('derives target labels from distinct roles rather than match count', () => {
    const match = buildAuditRecords([sourceRepo()], {
      software: [targetRepo()],
    })[0].matches[0];

    expect(targetRoleLabel([match, match])).toBe('software');
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

  it('retains an archive duplicate note when suffix resolution selects another row', () => {
    const unsuffixed = targetRepo({
      organization: 'acme-archive',
      repositoryName: 'one',
    });
    const records = buildAuditRecords(
      [sourceRepo()],
      {
        archive: [
          unsuffixed,
          targetRepo({
            organization: 'acme-archive',
            repositoryName: 'one-dova',
          }),
        ],
      },
      {
        archiveSuffix: '-dova',
        targetDuplicateGroups: {
          archive: [
            {
              normalizedName: 'one',
              occurrences: [
                unsuffixed,
                targetRepo({
                  organization: 'acme-archive',
                  repositoryName: 'ONE',
                }),
              ],
            },
          ],
        },
        onWarning: () => {},
      },
    );

    expect(records[0].matches[0].repositoryName).toBe('one-dova');
    expect(records[0].notes).toContain(AUDIT_NOTES.DUPLICATE_ARCHIVE_TARGET);
  });
});

describe('toAuditCsvRecord', () => {
  it('joins both-match fields with a slash and sanitizes formula-leading values', () => {
    const records = buildAuditRecords(
      [sourceRepo({ repositoryName: '=cmd' })],
      {
        software: [targetRepo({ repositoryName: '=cmd' })],
        archive: [
          targetRepo({
            organization: 'acme-archive',
            repositoryName: '=cmd-dova',
          }),
        ],
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
    expect(summary.duplicateGroupCount).toBe(0);
    expect(summary.duplicateExtraRowCount).toBe(0);
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
    expect(markdown).toContain(
      '[#123](https://github.com/acme/one/issues/123)',
    );
    expect(markdown).toContain('[one](https://github.com/acme/one)');
  });

  it('renders every duplicate occurrence without inflating repository totals', () => {
    const records = buildAuditRecords([sourceRepo()], {
      software: [targetRepo()],
    });
    const duplicateGroups = [
      {
        inputRole: 'software' as const,
        fileLabel: 'software target',
        normalizedName: 'one',
        occurrences: [
          targetRepo(),
          targetRepo({
            url: 'https://github.com/acme-software/one-copy',
            visibility: 'public',
          }),
        ],
      },
    ];
    const summary = summarizeAuditRecords(records, duplicateGroups);
    const markdown = renderAuditMarkdown(records, summary, {
      duplicateGroups,
    });

    expect(summary.totalRepos).toBe(1);
    expect(summary.duplicateGroupCount).toBe(1);
    expect(summary.duplicateExtraRowCount).toBe(1);
    expect(markdown).toContain('## Duplicate repository rows');
    expect(markdown).toContain('canonical row 1');
    expect(markdown).toContain('[one](https://github.com/acme-software/one)');
    expect(markdown).toContain(
      '[one](https://github.com/acme-software/one-copy)',
    );
    expect(markdown).toContain('| public |');
  });
});

const SOURCE_HEADERS_WITH_SECRET_SCANNING = `${SOURCE_HEADERS},has_open_secret_scan_alerts`;

function secretScanningSourceCsv(rows: string[]): string {
  return [SOURCE_HEADERS_WITH_SECRET_SCANNING, ...rows].join('\n') + '\n';
}

describe('open secret scanning alerts', () => {
  it('parses the optional column as a tri-state value', () => {
    const result = parseAuditSourceExport(
      secretScanningSourceCsv([
        'acme,one,https://github.com/acme/one,not-started,,false,true',
        'acme,two,https://github.com/acme/two,not-started,,false,false',
        'acme,three,https://github.com/acme/three,not-started,,false,',
      ]),
      'source',
    );
    expect(result.hasSecretScanColumn).toBe(true);
    expect(
      result.repositories.map((repo) => repo.hasOpenSecretScanAlerts),
    ).toEqual([true, false, undefined]);
  });

  it('reports unknown values for exports without the column', () => {
    const result = parseAuditSourceExport(
      sourceCsv(['acme,one,https://github.com/acme/one,success,123,true']),
      'source',
    );
    expect(result.hasSecretScanColumn).toBe(false);
    expect(result.repositories[0].hasOpenSecretScanAlerts).toBeUndefined();
  });

  it('adds a note for repositories with open alerts and counts them in the summary', () => {
    const source = parseAuditSourceExport(
      secretScanningSourceCsv([
        'acme,one,https://github.com/acme/one,not-started,,false,true',
        'acme,two,https://github.com/acme/two,not-started,,false,false',
        'acme,three,https://github.com/acme/three,not-started,,false,',
      ]),
      'source',
    ).repositories;
    const records = buildAuditRecords(source, {});

    expect(records[0].notes).toContain(AUDIT_NOTES.OPEN_SECRET_SCANNING_ALERTS);
    expect(records[1].notes).not.toContain(
      AUDIT_NOTES.OPEN_SECRET_SCANNING_ALERTS,
    );
    const summary = summarizeAuditRecords(records);
    expect(summary.openSecretScanAlertCount).toBe(1);
    expect(summary.unknownSecretScanCount).toBe(1);
  });

  it('omits the data entirely when the check is disabled', () => {
    const source = parseAuditSourceExport(
      secretScanningSourceCsv([
        'acme,one,https://github.com/acme/one,not-started,,false,true',
      ]),
      'source',
    ).repositories;
    const records = buildAuditRecords(
      source,
      {},
      { includeSecretScanning: false },
    );

    expect(records[0].hasOpenSecretScanAlerts).toBeUndefined();
    expect(records[0].notes).not.toContain(
      AUDIT_NOTES.OPEN_SECRET_SCANNING_ALERTS,
    );
    expect(
      renderAuditCsv(records, { includeSecretScanning: false }),
    ).not.toContain('has_open_secret_scan_alerts');
    expect(
      renderAuditMarkdown(records, summarizeAuditRecords(records), {
        includeSecretScanning: false,
      }),
    ).not.toContain('Open Secret Alerts');
  });

  it('renders the column in the CSV and Markdown outputs', () => {
    const source = parseAuditSourceExport(
      secretScanningSourceCsv([
        'acme,one,https://github.com/acme/one,not-started,,false,true',
        'acme,two,https://github.com/acme/two,not-started,,false,',
      ]),
      'source',
    ).repositories;
    const records = buildAuditRecords(source, {});

    const csvLines = renderAuditCsv(records).trim().split('\n');
    expect(csvLines[0]).toContain('has_open_secret_scan_alerts');
    const secretIndex = csvLines[0]
      .split(',')
      .indexOf('has_open_secret_scan_alerts');
    expect(csvLines[1].split(',')[secretIndex]).toBe('true');
    expect(csvLines[2].split(',')[secretIndex]).toBe('');

    const markdown = renderAuditMarkdown(
      records,
      summarizeAuditRecords(records),
      {},
    );
    expect(markdown).toContain('Open Secret Alerts (Source)');
    expect(markdown).toContain(
      'Repositories with open secret scanning alerts: **1**',
    );
    expect(markdown).toContain(
      'Repositories with unknown secret scanning alert state: **1**',
    );
    expect(markdown).toContain('open-secret-scanning-alerts');
  });
});

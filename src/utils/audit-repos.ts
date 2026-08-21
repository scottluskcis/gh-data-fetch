import path from 'path';
import { escapeCsvValue, parseCsvRecords, sanitizeCsvFormulaValue } from './csv.js';

export type TargetRole = 'software' | 'archive';

const TARGET_ROLES: TargetRole[] = ['software', 'archive'];

export interface AuditSourceRepo {
  organization: string;
  repositoryName: string;
  url: string;
  migrationStatus: string;
  migrationIssue: string;
  isLocked: boolean | undefined;
}

export interface AuditTargetRepo {
  organization: string;
  repositoryName: string;
  url: string;
  visibility: string;
  archived: boolean | undefined;
  createdAt: string;
  migrationIssue: string;
}

export interface TargetMatch {
  role: TargetRole;
  organization: string;
  repositoryName: string;
  url: string;
  visibility: string;
  archived: boolean | undefined;
  createdAt: string;
}

export interface AuditRecord {
  repoName: string;
  sourceOrg: string;
  sourceUrl: string;
  migrationStatus: string;
  migrationIssue: string;
  isLockedInSource: boolean | undefined;
  matches: TargetMatch[];
  notes: string[];
}

export const AUDIT_NOTES = {
  MATCHED_BOTH: 'matched-in-both-orgs',
  ISSUE_MISMATCH: 'migration-issue-mismatch',
  SUCCESS_NO_MATCH: 'status-success-but-no-match-found',
} as const;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function parseTriStateBoolean(value: string | undefined): boolean | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  return undefined;
}

function requireHeaders(
  records: Record<string, string>[],
  requiredHeaders: string[],
  fileLabel: string,
): void {
  if (records.length === 0) {
    throw new Error(`${fileLabel} does not contain any repository rows`);
  }
  const missing = requiredHeaders.filter(
    (header) => !Object.prototype.hasOwnProperty.call(records[0], header),
  );
  if (missing.length > 0) {
    throw new Error(
      `${fileLabel} is missing required column(s): ${missing.join(', ')}`,
    );
  }
}

function requireSingleOrganization(
  records: { organization_login: string }[],
  fileLabel: string,
): string {
  const organizations = new Set(
    records.map((record) => record.organization_login.trim()).filter(Boolean),
  );
  if (organizations.size === 0) {
    throw new Error(`${fileLabel} does not contain an organization_login value`);
  }
  if (organizations.size > 1) {
    throw new Error(
      `${fileLabel} must contain a single organization_login value; found: ${[
        ...organizations,
      ].join(', ')}`,
    );
  }
  return [...organizations][0];
}

function rejectDuplicateNames(names: string[], fileLabel: string): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = normalizeName(name);
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new Error(
        existing === name
          ? `${fileLabel} contains a duplicate repository name: "${name}"`
          : `${fileLabel} contains duplicate repository names "${existing}" and "${name}" that normalize to the same value`,
      );
    }
    seen.set(key, name);
  }
}

/**
 * Parses a full `list-org-repos` CSV export (source or target), preserving
 * the columns needed for auditing rather than only organization + name.
 */
export function parseAuditSourceExport(
  contents: string,
  fileLabel: string,
): { organization: string; repositories: AuditSourceRepo[] } {
  const records = parseCsvRecords(contents);
  requireHeaders(
    records,
    [
      'organization_login',
      'repository_name',
      'repository_url',
      'migration_status',
      'migration_issue',
      'is_locked',
    ],
    fileLabel,
  );
  const organization = requireSingleOrganization(
    records as { organization_login: string }[],
    fileLabel,
  );
  rejectDuplicateNames(
    records.map((record) => record.repository_name.trim()),
    fileLabel,
  );

  return {
    organization,
    repositories: records.map((record) => ({
      organization: record.organization_login.trim(),
      repositoryName: record.repository_name.trim(),
      url: record.repository_url?.trim() ?? '',
      migrationStatus: record.migration_status?.trim() ?? '',
      migrationIssue: record.migration_issue?.trim() ?? '',
      isLocked: parseTriStateBoolean(record.is_locked),
    })),
  };
}

export function parseAuditTargetExport(
  contents: string,
  fileLabel: string,
): { organization: string; repositories: AuditTargetRepo[] } {
  const records = parseCsvRecords(contents);
  requireHeaders(
    records,
    [
      'organization_login',
      'repository_name',
      'repository_url',
      'visibility',
      'archived',
      'created_at',
    ],
    fileLabel,
  );
  const organization = requireSingleOrganization(
    records as { organization_login: string }[],
    fileLabel,
  );
  rejectDuplicateNames(
    records.map((record) => record.repository_name.trim()),
    fileLabel,
  );

  return {
    organization,
    repositories: records.map((record) => ({
      organization: record.organization_login.trim(),
      repositoryName: record.repository_name.trim(),
      url: record.repository_url?.trim() ?? '',
      visibility: record.visibility?.trim() ?? '',
      archived: parseTriStateBoolean(record.archived),
      createdAt: record.created_at?.trim() ?? '',
      migrationIssue: record.migration_issue?.trim() ?? '',
    })),
  };
}

export interface TargetRepoListEntry {
  role: TargetRole;
  path: string;
}

/**
 * Parses and validates a single `--target-repo-list role=path` value,
 * accumulating into the array of previously parsed entries (for use as a
 * commander `argParser`).
 */
export function collectTargetRepoList(
  value: string,
  previous: TargetRepoListEntry[],
): TargetRepoListEntry[] {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(
      `Invalid --target-repo-list value "${value}"; expected format role=path (role: ${TARGET_ROLES.join(' or ')})`,
    );
  }
  const role = value.slice(0, separatorIndex).trim().toLowerCase();
  const filePath = value.slice(separatorIndex + 1).trim();
  if (!TARGET_ROLES.includes(role as TargetRole)) {
    throw new Error(
      `Invalid --target-repo-list role "${role}"; expected one of: ${TARGET_ROLES.join(', ')}`,
    );
  }
  if (!filePath) {
    throw new Error(`--target-repo-list role "${role}" is missing a file path`);
  }
  if (previous.some((entry) => entry.role === role)) {
    throw new Error(
      `--target-repo-list role "${role}" was specified more than once`,
    );
  }
  return [...previous, { role: role as TargetRole, path: filePath }];
}

/**
 * Strips a case-insensitive terminal suffix from an archive repository name.
 * Returns null when the name does not end with the suffix.
 */
export function stripArchiveSuffix(
  name: string,
  suffix: string,
): string | null {
  if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
    return name.slice(0, name.length - suffix.length);
  }
  return null;
}

function buildTargetLookup(
  role: TargetRole,
  repos: AuditTargetRepo[],
  fileLabel: string,
  archiveSuffix?: string,
): Map<string, AuditTargetRepo> {
  const map = new Map<string, AuditTargetRepo>();
  for (const repo of repos) {
    let key = normalizeName(repo.repositoryName);
    if (role === 'archive') {
      if (!archiveSuffix) {
        throw new Error(
          '--archive-suffix is required when an archive target is provided',
        );
      }
      const stripped = stripArchiveSuffix(repo.repositoryName, archiveSuffix);
      if (stripped !== null) {
        if (stripped.length === 0) {
          throw new Error(
            `${fileLabel}: archive repository "${repo.repositoryName}" is exactly the archive suffix "${archiveSuffix}"; cannot determine the source repository name`,
          );
        }
        key = normalizeName(stripped);
      }
    }
    if (map.has(key)) {
      throw new Error(
        `${fileLabel}: duplicate ${role} target repository name after normalization: "${key}"`,
      );
    }
    map.set(key, repo);
  }
  return map;
}

export interface BuildAuditRecordsOptions {
  archiveSuffix?: string;
  softwareFileLabel?: string;
  archiveFileLabel?: string;
}

/**
 * Matches source repositories against software/archive target exports and
 * produces one audit record per source repository, in source order.
 */
export function buildAuditRecords(
  source: AuditSourceRepo[],
  targetsByRole: Partial<Record<TargetRole, AuditTargetRepo[]>>,
  options: BuildAuditRecordsOptions = {},
): AuditRecord[] {
  const softwareLookup = targetsByRole.software
    ? buildTargetLookup(
        'software',
        targetsByRole.software,
        options.softwareFileLabel ?? 'software target file',
      )
    : undefined;
  const archiveLookup = targetsByRole.archive
    ? buildTargetLookup(
        'archive',
        targetsByRole.archive,
        options.archiveFileLabel ?? 'archive target file',
        options.archiveSuffix,
      )
    : undefined;

  return source.map((repo) => {
    const key = normalizeName(repo.repositoryName);
    const matches: TargetMatch[] = [];
    const notes: string[] = [];

    const softwareMatch = softwareLookup?.get(key);
    if (softwareMatch) {
      matches.push({
        role: 'software',
        organization: softwareMatch.organization,
        repositoryName: softwareMatch.repositoryName,
        url: softwareMatch.url,
        visibility: softwareMatch.visibility,
        archived: softwareMatch.archived,
        createdAt: softwareMatch.createdAt,
      });
      const sourceIssue = repo.migrationIssue;
      const targetIssue = softwareMatch.migrationIssue;
      if (sourceIssue && targetIssue && sourceIssue !== targetIssue) {
        notes.push(AUDIT_NOTES.ISSUE_MISMATCH);
      }
    }

    const archiveMatch = archiveLookup?.get(key);
    if (archiveMatch) {
      matches.push({
        role: 'archive',
        organization: archiveMatch.organization,
        repositoryName: archiveMatch.repositoryName,
        url: archiveMatch.url,
        visibility: archiveMatch.visibility,
        archived: archiveMatch.archived,
        createdAt: archiveMatch.createdAt,
      });
    }

    if (matches.length > 1) {
      notes.push(AUDIT_NOTES.MATCHED_BOTH);
    }

    if (
      matches.length === 0 &&
      repo.migrationStatus.toLowerCase() === 'success'
    ) {
      notes.push(AUDIT_NOTES.SUCCESS_NO_MATCH);
    }

    return {
      repoName: repo.repositoryName,
      sourceOrg: repo.organization,
      sourceUrl: repo.url,
      migrationStatus: repo.migrationStatus,
      migrationIssue: repo.migrationIssue,
      isLockedInSource: repo.isLocked,
      matches,
      notes,
    };
  });
}

export function targetRoleLabel(matches: TargetMatch[]): string {
  if (matches.length === 0) {
    return 'none';
  }
  if (matches.length > 1) {
    return 'both';
  }
  return matches[0].role;
}

function joinMatchField(
  matches: TargetMatch[],
  selector: (match: TargetMatch) => string,
): string {
  return matches.map(selector).join('/');
}

export const AUDIT_CSV_HEADERS = [
  'repo_name',
  'source_org',
  'source_url',
  'migrated_to_org',
  'target_org',
  'migration_status',
  'migration_issue',
  'target_url',
  'visibility_in_target',
  'archived_in_target',
  'created_at_in_target',
  'locked_in_source',
  'notes',
];

function lockedDisplayValue(value: boolean | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * Renders an audit record into a flat CSV row, sanitizing every string
 * value against spreadsheet formula injection.
 */
export function toAuditCsvRecord(
  record: AuditRecord,
): Record<string, string> {
  const raw: Record<string, string> = {
    repo_name: record.repoName,
    source_org: record.sourceOrg,
    source_url: record.sourceUrl,
    migrated_to_org: joinMatchField(record.matches, (match) => match.organization),
    target_org: targetRoleLabel(record.matches),
    migration_status: record.migrationStatus,
    migration_issue: record.migrationIssue,
    target_url: joinMatchField(record.matches, (match) => match.url),
    visibility_in_target: joinMatchField(
      record.matches,
      (match) => match.visibility,
    ),
    archived_in_target: joinMatchField(record.matches, (match) =>
      match.archived === undefined ? '' : String(match.archived),
    ),
    created_at_in_target: joinMatchField(
      record.matches,
      (match) => match.createdAt,
    ),
    locked_in_source: lockedDisplayValue(record.isLockedInSource),
    notes: record.notes.join(';'),
  };

  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      String(sanitizeCsvFormulaValue(value) ?? ''),
    ]),
  );
}

export interface AuditOutputPaths {
  csvPath: string;
  markdownPath: string;
}

/**
 * Derives the Markdown report path from the CSV output path (e.g.
 * `audit.csv` -> `audit.md`), and validates that the two paths differ.
 */
export function deriveMarkdownPath(csvPath: string): string {
  const ext = path.extname(csvPath);
  const base = ext ? csvPath.slice(0, -ext.length) : csvPath;
  const markdownPath = `${base}.md`;
  if (markdownPath === csvPath) {
    throw new Error(
      `Unable to derive a distinct Markdown report path from "${csvPath}"; choose an --output-file with a .csv extension`,
    );
  }
  return markdownPath;
}

/**
 * Renders audit records into full CSV file content (header + rows), with
 * every field passed through the shared CSV escaping/sanitization helpers.
 */
export function renderAuditCsv(records: AuditRecord[]): string {
  const rows = records.map((record) => toAuditCsvRecord(record));
  const lines = [AUDIT_CSV_HEADERS.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(
      AUDIT_CSV_HEADERS.map((header) => escapeCsvValue(row[header])).join(
        ',',
      ),
    );
  }
  return lines.join('\n') + '\n';
}

export interface AuditSummary {
  totalRepos: number;
  byStatus: Record<string, number>;
  byTargetLabel: Record<string, number>;
  anomalyCount: number;
}

export function summarizeAuditRecords(records: AuditRecord[]): AuditSummary {
  const byStatus: Record<string, number> = {};
  const byTargetLabel: Record<string, number> = {};
  let anomalyCount = 0;

  for (const record of records) {
    const statusKey = record.migrationStatus.trim().toLowerCase() || '(unknown)';
    byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;

    const targetLabel = targetRoleLabel(record.matches);
    byTargetLabel[targetLabel] = (byTargetLabel[targetLabel] ?? 0) + 1;

    if (record.notes.length > 0) {
      anomalyCount++;
    }
  }

  return {
    totalRepos: records.length,
    byStatus,
    byTargetLabel,
    anomalyCount,
  };
}

const STATUS_DISPLAY_ORDER = ['success', 'in-progress', 'not-started', 'failure'];
const TARGET_LABEL_DISPLAY_ORDER = ['software', 'archive', 'both', 'none'];

function orderedKeys(
  present: string[],
  preferredOrder: string[],
): string[] {
  const remaining = present
    .filter((key) => !preferredOrder.includes(key))
    .sort((left, right) => left.localeCompare(right));
  return [...preferredOrder.filter((key) => present.includes(key)), ...remaining];
}

function escapeMarkdown(value: string): string {
  return value.replace(/[|<>]/g, (char) => `\\${char}`);
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function markdownLink(label: string, url: string | undefined): string {
  const safeLabel = escapeMarkdown(label || '(unknown)');
  if (url && isSafeHttpUrl(url)) {
    return `[${safeLabel}](${url})`;
  }
  return safeLabel;
}

function renderTargetLinks(matches: TargetMatch[]): string {
  if (matches.length === 0) {
    return '';
  }
  return matches
    .map((match) => markdownLink(match.repositoryName, match.url))
    .join(', ');
}

function renderMigrationIssue(
  migrationIssue: string,
  migrationIssueUrlPrefix: string | undefined,
): string {
  const trimmed = migrationIssue.trim();
  if (!trimmed) {
    return '';
  }
  if (migrationIssueUrlPrefix && /^\d+$/.test(trimmed)) {
    const url = `${migrationIssueUrlPrefix}${trimmed}`;
    if (isSafeHttpUrl(url)) {
      return `[#${trimmed}](${url})`;
    }
  }
  return escapeMarkdown(trimmed);
}

function renderLockedValue(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : String(value);
}

function renderArchivedValues(matches: TargetMatch[]): string {
  if (matches.length === 0) {
    return '';
  }
  return matches
    .map((match) => (match.archived === undefined ? 'unknown' : String(match.archived)))
    .join(', ');
}

function renderVisibilityValues(matches: TargetMatch[]): string {
  return matches.map((match) => match.visibility || '(unknown)').join(', ');
}

function renderCreatedAtValues(matches: TargetMatch[]): string {
  return matches.map((match) => match.createdAt || '(unknown)').join(', ');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface RenderMarkdownOptions {
  title?: string;
  migrationIssueUrlPrefix?: string;
}

/**
 * Renders a human-readable Markdown report grouped by migration status,
 * then by target, with a summary counts table at the top and collapsible
 * `<details>` sections per group.
 */
export function renderAuditMarkdown(
  records: AuditRecord[],
  summary: AuditSummary,
  options: RenderMarkdownOptions = {},
): string {
  const lines: string[] = [];
  const title = options.title ?? 'Repository Migration Audit';

  lines.push(`# ${title}`, '');
  lines.push('## Summary', '');
  lines.push(`Total source repositories: **${summary.totalRepos}**`, '');

  lines.push('### By migration status', '');
  lines.push('| Status | Count |', '| --- | --- |');
  for (const status of orderedKeys(
    Object.keys(summary.byStatus),
    STATUS_DISPLAY_ORDER,
  )) {
    lines.push(`| ${escapeMarkdown(status)} | ${summary.byStatus[status]} |`);
  }
  lines.push('');

  lines.push('### By migration target', '');
  lines.push('| Target | Count |', '| --- | --- |');
  for (const target of orderedKeys(
    Object.keys(summary.byTargetLabel),
    TARGET_LABEL_DISPLAY_ORDER,
  )) {
    lines.push(`| ${escapeMarkdown(target)} | ${summary.byTargetLabel[target]} |`);
  }
  lines.push('', `Repositories with anomaly notes: **${summary.anomalyCount}**`, '');

  lines.push('## Repositories by status and target', '');

  const statusGroups = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const statusKey = record.migrationStatus.trim().toLowerCase() || '(unknown)';
    const bucket = statusGroups.get(statusKey) ?? [];
    bucket.push(record);
    statusGroups.set(statusKey, bucket);
  }

  for (const status of orderedKeys(
    [...statusGroups.keys()],
    STATUS_DISPLAY_ORDER,
  )) {
    const statusRecords = statusGroups.get(status) ?? [];
    const targetGroups = new Map<string, AuditRecord[]>();
    for (const record of statusRecords) {
      const targetLabel = targetRoleLabel(record.matches);
      const bucket = targetGroups.get(targetLabel) ?? [];
      bucket.push(record);
      targetGroups.set(targetLabel, bucket);
    }

    for (const target of orderedKeys(
      [...targetGroups.keys()],
      TARGET_LABEL_DISPLAY_ORDER,
    )) {
      const groupRecords = targetGroups.get(target) ?? [];
      lines.push('<details>');
      lines.push(
        `<summary>Status: ${capitalize(status)} — Target: ${capitalize(target)} (${groupRecords.length} repos)</summary>`,
      );
      lines.push('');
      lines.push(
        '| Source Repository | Target Repository | Migration Issue | Migration Status | Visibility (Target) | Archived (Target) | Created At (Target) | Locked (Source) | Notes |',
      );
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const record of groupRecords) {
        const cells = [
          markdownLink(record.repoName, record.sourceUrl),
          renderTargetLinks(record.matches),
          renderMigrationIssue(
            record.migrationIssue,
            options.migrationIssueUrlPrefix,
          ),
          escapeMarkdown(record.migrationStatus),
          renderVisibilityValues(record.matches),
          renderArchivedValues(record.matches),
          renderCreatedAtValues(record.matches),
          renderLockedValue(record.isLockedInSource),
          record.notes.map(escapeMarkdown).join('; '),
        ];
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
      lines.push('</details>', '');
    }
  }

  return lines.join('\n');
}


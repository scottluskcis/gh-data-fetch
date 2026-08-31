import path from 'path';
import {
  escapeCsvValue,
  parseCsvRecords,
  sanitizeCsvFormulaValue,
} from './csv.js';

export type TargetRole = 'software' | 'archive';

const TARGET_ROLES: TargetRole[] = ['software', 'archive'];

export interface AuditSourceRepo {
  organization: string;
  repositoryName: string;
  url: string;
  migrationStatus: string;
  migrationIssue: string;
  isLocked: boolean | undefined;
  hasOpenSecretScanAlerts: boolean | undefined;
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

export interface AuditDuplicateGroup<T> {
  normalizedName: string;
  occurrences: T[];
}

export interface ParsedAuditExport<T> {
  organization: string;
  repositories: T[];
  duplicateGroups: AuditDuplicateGroup<T>[];
}

export const SECRET_SCAN_COLUMN = 'has_open_secret_scan_alerts';

export interface ParsedAuditSourceExport extends ParsedAuditExport<AuditSourceRepo> {
  /**
   * Whether the source export contained the optional
   * `has_open_secret_scan_alerts` column; exports produced before the column
   * was added are still supported, with unknown values.
   */
  hasSecretScanColumn: boolean;
}

export type AuditDuplicateReportGroup =
  | (AuditDuplicateGroup<AuditSourceRepo> & {
      inputRole: 'source';
      fileLabel: string;
    })
  | (AuditDuplicateGroup<AuditTargetRepo> & {
      inputRole: TargetRole;
      fileLabel: string;
    });

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
  hasOpenSecretScanAlerts: boolean | undefined;
  matches: TargetMatch[];
  notes: string[];
}

export const AUDIT_NOTES = {
  MATCHED_BOTH: 'matched-in-both-orgs',
  ISSUE_MISMATCH: 'migration-issue-mismatch',
  SUCCESS_NO_MATCH: 'status-success-but-no-match-found',
  OPEN_SECRET_SCANNING_ALERTS: 'open-secret-scanning-alerts',
  DUPLICATE_SOURCE: 'duplicate-source-repository-row',
  DUPLICATE_SOFTWARE_TARGET: 'duplicate-software-target-repository-row',
  DUPLICATE_ARCHIVE_TARGET: 'duplicate-archive-target-repository-row',
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
    throw new Error(
      `${fileLabel} does not contain an organization_login value`,
    );
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

function canonicalizeByRepositoryName<T extends { repositoryName: string }>(
  repositories: T[],
): {
  repositories: T[];
  duplicateGroups: AuditDuplicateGroup<T>[];
} {
  const groups = new Map<string, T[]>();
  for (const repository of repositories) {
    const key = normalizeName(repository.repositoryName);
    const occurrences = groups.get(key) ?? [];
    occurrences.push(repository);
    groups.set(key, occurrences);
  }

  return {
    repositories: [...groups.values()].map(([first]) => first),
    duplicateGroups: [...groups.entries()]
      .filter(([, occurrences]) => occurrences.length > 1)
      .map(([normalizedName, occurrences]) => ({
        normalizedName,
        occurrences,
      })),
  };
}

/**
 * Parses a full `list-org-repos` CSV export (source or target), preserving
 * the columns needed for auditing rather than only organization + name.
 */
export function parseAuditSourceExport(
  contents: string,
  fileLabel: string,
): ParsedAuditSourceExport {
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
  const parsedRepositories = records.map((record) => ({
    organization: record.organization_login.trim(),
    repositoryName: record.repository_name.trim(),
    url: record.repository_url?.trim() ?? '',
    migrationStatus: record.migration_status?.trim() ?? '',
    migrationIssue: record.migration_issue?.trim() ?? '',
    isLocked: parseTriStateBoolean(record.is_locked),
    hasOpenSecretScanAlerts: parseTriStateBoolean(record[SECRET_SCAN_COLUMN]),
  }));
  const { repositories, duplicateGroups } =
    canonicalizeByRepositoryName(parsedRepositories);

  return {
    organization,
    repositories,
    duplicateGroups,
    hasSecretScanColumn: Object.prototype.hasOwnProperty.call(
      records[0],
      SECRET_SCAN_COLUMN,
    ),
  };
}

export function parseAuditTargetExport(
  contents: string,
  fileLabel: string,
): ParsedAuditExport<AuditTargetRepo> {
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
  const parsedRepositories = records.map((record) => ({
    organization: record.organization_login.trim(),
    repositoryName: record.repository_name.trim(),
    url: record.repository_url?.trim() ?? '',
    visibility: record.visibility?.trim() ?? '',
    archived: parseTriStateBoolean(record.archived),
    createdAt: record.created_at?.trim() ?? '',
    migrationIssue: record.migration_issue?.trim() ?? '',
  }));
  const { repositories, duplicateGroups } =
    canonicalizeByRepositoryName(parsedRepositories);

  return {
    organization,
    repositories,
    duplicateGroups,
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
  onWarning: (message: string) => void = (message) =>
    console.warn(`Warning: ${message}`),
): Map<string, AuditTargetRepo> {
  const map = new Map<string, AuditTargetRepo>();
  const archiveSuffixMatches =
    role === 'archive' ? new Set<string>() : undefined;
  for (const repo of repos) {
    let key = normalizeName(repo.repositoryName);
    let matchedArchiveSuffix = false;
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
        matchedArchiveSuffix = true;
      }
    }
    const existing = map.get(key);
    if (existing) {
      if (role !== 'archive') {
        throw new Error(
          `${fileLabel}: duplicate ${role} target repository name after normalization: "${key}"`,
        );
      }
      const existingMatchedArchiveSuffix =
        archiveSuffixMatches?.has(key) ?? false;
      const preferCurrent =
        matchedArchiveSuffix && !existingMatchedArchiveSuffix;
      const preferred = preferCurrent ? repo : existing;
      const ignored = preferCurrent ? existing : repo;
      onWarning(
        `${fileLabel}: duplicate ${role} target repository name after normalization: "${key}"; using "${preferred.repositoryName}" and ignoring "${ignored.repositoryName}"`,
      );
      if (preferCurrent) {
        map.set(key, repo);
        archiveSuffixMatches?.add(key);
      }
      continue;
    }
    map.set(key, repo);
    if (matchedArchiveSuffix) {
      archiveSuffixMatches?.add(key);
    }
  }
  return map;
}

export interface BuildAuditRecordsOptions {
  archiveSuffix?: string;
  softwareFileLabel?: string;
  archiveFileLabel?: string;
  onWarning?: (message: string) => void;
  sourceDuplicateGroups?: AuditDuplicateGroup<AuditSourceRepo>[];
  targetDuplicateGroups?: Partial<
    Record<TargetRole, AuditDuplicateGroup<AuditTargetRepo>[]>
  >;
  /**
   * When false, open secret scanning alert data from the source export is
   * ignored entirely (no value on the record, no note).
   */
  includeSecretScanning?: boolean;
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
  const includeSecretScanning = options.includeSecretScanning !== false;
  const sourceDuplicateNames = new Set(
    options.sourceDuplicateGroups?.map((group) => group.normalizedName) ?? [],
  );
  const softwareDuplicateNames = new Set(
    options.targetDuplicateGroups?.software?.map(
      (group) => group.normalizedName,
    ) ?? [],
  );
  const archiveDuplicateNames = new Set(
    options.targetDuplicateGroups?.archive?.map((group) => {
      const stripped = options.archiveSuffix
        ? stripArchiveSuffix(group.normalizedName, options.archiveSuffix)
        : null;
      return normalizeName(stripped ?? group.normalizedName);
    }) ?? [],
  );
  const softwareLookup = targetsByRole.software
    ? buildTargetLookup(
        'software',
        targetsByRole.software,
        options.softwareFileLabel ?? 'software target file',
        undefined,
        options.onWarning,
      )
    : undefined;
  const archiveLookup = targetsByRole.archive
    ? buildTargetLookup(
        'archive',
        targetsByRole.archive,
        options.archiveFileLabel ?? 'archive target file',
        options.archiveSuffix,
        options.onWarning,
      )
    : undefined;

  return source.map((repo) => {
    const key = normalizeName(repo.repositoryName);
    const matches: TargetMatch[] = [];
    const notes: string[] = [];
    if (sourceDuplicateNames.has(key)) {
      notes.push(AUDIT_NOTES.DUPLICATE_SOURCE);
    }

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
      if (
        softwareDuplicateNames.has(normalizeName(softwareMatch.repositoryName))
      ) {
        notes.push(AUDIT_NOTES.DUPLICATE_SOFTWARE_TARGET);
      }
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
      if (archiveDuplicateNames.has(key)) {
        notes.push(AUDIT_NOTES.DUPLICATE_ARCHIVE_TARGET);
      }
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

    if (repo.hasOpenSecretScanAlerts === true && includeSecretScanning) {
      notes.push(AUDIT_NOTES.OPEN_SECRET_SCANNING_ALERTS);
    }

    return {
      repoName: repo.repositoryName,
      sourceOrg: repo.organization,
      sourceUrl: repo.url,
      migrationStatus: repo.migrationStatus,
      migrationIssue: repo.migrationIssue,
      isLockedInSource: repo.isLocked,
      hasOpenSecretScanAlerts: includeSecretScanning
        ? repo.hasOpenSecretScanAlerts
        : undefined,
      matches,
      notes,
    };
  });
}

export function targetRoleLabel(matches: TargetMatch[]): string {
  const roles = new Set(matches.map((match) => match.role));
  if (roles.size === 0) {
    return 'none';
  }
  if (roles.size > 1) {
    return 'both';
  }
  return [...roles][0];
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
  SECRET_SCAN_COLUMN,
  'notes',
];

/**
 * CSV headers used when the secret scanning check is disabled.
 */
export const AUDIT_CSV_HEADERS_WITHOUT_SECRET_SCANNING =
  AUDIT_CSV_HEADERS.filter((header) => header !== SECRET_SCAN_COLUMN);

export function auditCsvHeaders(includeSecretScanning = true): string[] {
  return includeSecretScanning
    ? AUDIT_CSV_HEADERS
    : AUDIT_CSV_HEADERS_WITHOUT_SECRET_SCANNING;
}

function lockedDisplayValue(value: boolean | undefined): string {
  return value === undefined ? '' : String(value);
}
/**
 * Renders an audit record into a flat CSV row, sanitizing every string
 * value against spreadsheet formula injection.
 */
export function toAuditCsvRecord(record: AuditRecord): Record<string, string> {
  const raw: Record<string, string> = {
    repo_name: record.repoName,
    source_org: record.sourceOrg,
    source_url: record.sourceUrl,
    migrated_to_org: joinMatchField(
      record.matches,
      (match) => match.organization,
    ),
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
    [SECRET_SCAN_COLUMN]: lockedDisplayValue(record.hasOpenSecretScanAlerts),
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
export function renderAuditCsv(
  records: AuditRecord[],
  options: { includeSecretScanning?: boolean } = {},
): string {
  const headers = auditCsvHeaders(options.includeSecretScanning !== false);
  const rows = records.map((record) => toAuditCsvRecord(record));
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvValue(row[header])).join(','));
  }
  return lines.join('\n') + '\n';
}

export interface AuditSummary {
  totalRepos: number;
  byStatus: Record<string, number>;
  byTargetLabel: Record<string, number>;
  anomalyCount: number;
  duplicateGroupCount: number;
  duplicateExtraRowCount: number;
  openSecretScanAlertCount: number;
  unknownSecretScanCount: number;
}

export function summarizeAuditRecords(
  records: AuditRecord[],
  duplicateGroups: AuditDuplicateReportGroup[] = [],
): AuditSummary {
  const byStatus: Record<string, number> = {};
  const byTargetLabel: Record<string, number> = {};
  let anomalyCount = 0;
  let openSecretScanAlertCount = 0;
  let unknownSecretScanCount = 0;

  for (const record of records) {
    const statusKey =
      record.migrationStatus.trim().toLowerCase() || '(unknown)';
    byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;

    const targetLabel = targetRoleLabel(record.matches);
    byTargetLabel[targetLabel] = (byTargetLabel[targetLabel] ?? 0) + 1;

    if (record.notes.length > 0) {
      anomalyCount++;
    }

    if (record.hasOpenSecretScanAlerts === true) {
      openSecretScanAlertCount++;
    } else if (record.hasOpenSecretScanAlerts === undefined) {
      unknownSecretScanCount++;
    }
  }

  return {
    totalRepos: records.length,
    byStatus,
    byTargetLabel,
    anomalyCount,
    openSecretScanAlertCount,
    unknownSecretScanCount,
    duplicateGroupCount: duplicateGroups.length,
    duplicateExtraRowCount: duplicateGroups.reduce(
      (count, group) => count + group.occurrences.length - 1,
      0,
    ),
  };
}

const STATUS_DISPLAY_ORDER = [
  'success',
  'in-progress',
  'not-started',
  'failure',
];
const TARGET_LABEL_DISPLAY_ORDER = ['software', 'archive', 'both', 'none'];

function orderedKeys(present: string[], preferredOrder: string[]): string[] {
  const remaining = present
    .filter((key) => !preferredOrder.includes(key))
    .sort((left, right) => left.localeCompare(right));
  return [
    ...preferredOrder.filter((key) => present.includes(key)),
    ...remaining,
  ];
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
    .map((match) =>
      match.archived === undefined ? 'unknown' : String(match.archived),
    )
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
  duplicateGroups?: AuditDuplicateReportGroup[];
  includeSecretScanning?: boolean;
}

function renderSecretScanValue(value: boolean | undefined): string {
  return value === undefined ? 'unknown' : String(value);
}

function renderDuplicateGroups(
  lines: string[],
  duplicateGroups: AuditDuplicateReportGroup[],
  includeSecretScanning: boolean,
): void {
  lines.push('## Duplicate repository rows', '');
  if (duplicateGroups.length === 0) {
    lines.push('No duplicate repository rows found.', '');
    return;
  }

  for (const group of duplicateGroups) {
    const roleLabel =
      group.inputRole === 'source'
        ? 'Source'
        : `${capitalize(group.inputRole)} target`;
    lines.push('<details>');
    lines.push(
      `<summary>${roleLabel}: ${escapeMarkdown(group.normalizedName)} (${group.occurrences.length} rows; canonical row 1)</summary>`,
    );
    lines.push('');
    lines.push(`Input: \`${escapeMarkdown(group.fileLabel)}\``, '');

    if (group.inputRole === 'source') {
      const secretHeader = includeSecretScanning ? ' Open Secret Alerts |' : '';
      const secretDivider = includeSecretScanning ? ' --- |' : '';
      lines.push(
        `| Row | Organization | Repository | Migration Status | Migration Issue | Locked |${secretHeader}`,
      );
      lines.push(`| --- | --- | --- | --- | --- | --- |${secretDivider}`);
      group.occurrences.forEach((occurrence, index) => {
        const secretCell = includeSecretScanning
          ? ` ${renderSecretScanValue(occurrence.hasOpenSecretScanAlerts)} |`
          : '';
        lines.push(
          `| ${index + 1} | ${escapeMarkdown(occurrence.organization)} | ${markdownLink(occurrence.repositoryName, occurrence.url)} | ${escapeMarkdown(occurrence.migrationStatus)} | ${escapeMarkdown(occurrence.migrationIssue)} | ${renderLockedValue(occurrence.isLocked)} |${secretCell}`,
        );
      });
    } else {
      lines.push(
        '| Row | Organization | Repository | Visibility | Archived | Created At | Migration Issue |',
      );
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      group.occurrences.forEach((occurrence, index) => {
        lines.push(
          `| ${index + 1} | ${escapeMarkdown(occurrence.organization)} | ${markdownLink(occurrence.repositoryName, occurrence.url)} | ${escapeMarkdown(occurrence.visibility)} | ${occurrence.archived === undefined ? 'unknown' : occurrence.archived} | ${escapeMarkdown(occurrence.createdAt)} | ${escapeMarkdown(occurrence.migrationIssue)} |`,
        );
      });
    }
    lines.push('');
    lines.push('</details>', '');
  }
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
  const includeSecretScanning = options.includeSecretScanning !== false;

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
    lines.push(
      `| ${escapeMarkdown(target)} | ${summary.byTargetLabel[target]} |`,
    );
  }
  lines.push(
    '',
    `Repositories with anomaly notes: **${summary.anomalyCount}**`,
    '',
  );
  lines.push(
    `Duplicate repository groups: **${summary.duplicateGroupCount}**`,
    '',
  );
  lines.push(
    `Additional duplicate rows: **${summary.duplicateExtraRowCount}**`,
    '',
  );
  if (includeSecretScanning) {
    lines.push(
      `Repositories with open secret scanning alerts: **${summary.openSecretScanAlertCount}**`,
      '',
    );
    if (summary.unknownSecretScanCount > 0) {
      lines.push(
        `Repositories with unknown secret scanning alert state: **${summary.unknownSecretScanCount}**`,
        '',
      );
    }
  }

  lines.push('## Repositories by status and target', '');

  const statusGroups = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const statusKey =
      record.migrationStatus.trim().toLowerCase() || '(unknown)';
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
        `| Source Repository | Target Repository | Migration Issue | Migration Status | Visibility (Target) | Archived (Target) | Created At (Target) | Locked (Source) |${includeSecretScanning ? ' Open Secret Alerts (Source) |' : ''} Notes |`,
      );
      lines.push(
        `| --- | --- | --- | --- | --- | --- | --- | --- |${includeSecretScanning ? ' --- |' : ''} --- |`,
      );
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
          ...(includeSecretScanning
            ? [renderSecretScanValue(record.hasOpenSecretScanAlerts)]
            : []),
          record.notes.map(escapeMarkdown).join('; '),
        ];
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
      lines.push('</details>', '');
    }
  }

  renderDuplicateGroups(
    lines,
    options.duplicateGroups ?? [],
    includeSecretScanning,
  );

  return lines.join('\n');
}

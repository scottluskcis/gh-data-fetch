import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import {
  executeWithOctokit,
  type Logger,
  type RetryConfig,
} from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import type { Octokit } from 'octokit';
import { executeApiOperation } from '../utils/api-operation.js';
import {
  ensureOutputPathWritable,
  escapeCsvValue,
  sanitizeCsvFormulaValue,
} from '../utils/csv.js';
import {
  createCommandWithSharedOptions,
  parseBooleanOption,
  retryConfigFromOptions,
} from './command-helpers.js';

const HEADERS = [
  'renamed_at',
  'original_repository_name',
  'new_repository_name',
  'actor',
] as const;

export interface RepoRenameRecord {
  renamed_at: string;
  original_repository_name: string;
  new_repository_name: string;
  actor: string;
}

export interface AuditLogEntry {
  action?: unknown;
  actor?: unknown;
  created_at?: unknown;
  old_name?: unknown;
  repo?: unknown;
  ['@timestamp']?: unknown;
}

export interface DateRange {
  startDate?: string;
  endDate?: string;
}

interface AuditLogPage {
  entries: AuditLogEntry[];
  nextCursor?: string;
}

function normalizeAuditLogEntries(value: unknown): AuditLogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub returned a non-array audit log response');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `GitHub returned an invalid audit log entry at index ${index}`,
      );
    }
    const fields = entry as Record<string, unknown>;
    return {
      action: fields.action,
      actor: fields.actor,
      created_at: fields.created_at,
      old_name: fields.old_name,
      repo: fields.repo,
      '@timestamp': fields['@timestamp'],
    };
  });
}

function parseCalendarDate(value: string, optionName: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${optionName} must use YYYY-MM-DD format`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${optionName} must be a valid calendar date`);
  }
  return value;
}

export function validateDateRange(range: DateRange): DateRange {
  const startDate = range.startDate
    ? parseCalendarDate(range.startDate, '--start-date')
    : undefined;
  const endDate = range.endDate
    ? parseCalendarDate(range.endDate, '--end-date')
    : undefined;

  if (startDate && endDate && startDate > endDate) {
    throw new Error('--start-date must be on or before --end-date');
  }
  return { startDate, endDate };
}

export function validatePageSize(value: unknown): number {
  const pageSize = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('--page-size must be an integer from 1 to 100');
  }
  return pageSize;
}

export function buildAuditLogPhrase(range: DateRange): string {
  const terms = ['action:repo.rename'];
  if (range.startDate) {
    terms.push(`created:>=${range.startDate}`);
  }
  if (range.endDate) {
    terms.push(`created:<=${range.endDate}`);
  }
  return terms.join(' ');
}

export function nextAuditLogCursor(
  linkHeader: string | undefined,
): string | undefined {
  if (!linkHeader) {
    return undefined;
  }

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) {
      continue;
    }
    const cursor = new URL(match[1]).searchParams.get('after');
    return cursor ?? undefined;
  }
  return undefined;
}

function auditTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function qualifiedOldName(oldName: string, newName: string): string {
  if (oldName.includes('/')) {
    return oldName;
  }
  const separator = newName.indexOf('/');
  return separator === -1
    ? oldName
    : `${newName.slice(0, separator)}/${oldName}`;
}

export function parseRepoRenameEntries(entries: AuditLogEntry[]): {
  records: RepoRenameRecord[];
  skipped: number;
} {
  const records = new Map<string, RepoRenameRecord>();
  let skipped = 0;

  for (const entry of entries) {
    if (entry.action !== 'repo.rename') {
      continue;
    }

    const renamedAt = auditTimestamp(entry.created_at ?? entry['@timestamp']);
    const oldName =
      typeof entry.old_name === 'string' && entry.old_name.length > 0
        ? entry.old_name
        : undefined;
    const newName =
      typeof entry.repo === 'string' && entry.repo.length > 0
        ? entry.repo
        : undefined;
    const actor =
      typeof entry.actor === 'string' && entry.actor.length > 0
        ? entry.actor
        : undefined;

    if (!renamedAt || !oldName || !newName || !actor) {
      skipped++;
      continue;
    }

    const record: RepoRenameRecord = {
      renamed_at: renamedAt,
      original_repository_name: qualifiedOldName(oldName, newName),
      new_repository_name: newName,
      actor,
    };
    records.set(JSON.stringify(record), record);
  }

  return { records: [...records.values()], skipped };
}

async function fetchAuditLogPage(
  octokit: Octokit,
  organization: string,
  phrase: string,
  perPage: number,
  after: string | undefined,
): Promise<AuditLogPage> {
  const response = await octokit.request('GET /orgs/{org}/audit-log', {
    org: organization,
    phrase,
    include: 'web',
    order: 'asc',
    per_page: perPage,
    after,
    headers: {
      'x-github-api-version': '2022-11-28',
    },
  });
  return {
    entries: normalizeAuditLogEntries(response.data),
    nextCursor: nextAuditLogCursor(response.headers.link),
  };
}

export async function fetchRepoRenameEntries(options: {
  octokit: Octokit;
  organization: string;
  phrase: string;
  perPage: number;
  retryConfig: RetryConfig;
  retryDisabled: boolean;
  logger: Logger;
}): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  do {
    const page = await executeApiOperation(
      () =>
        fetchAuditLogPage(
          options.octokit,
          options.organization,
          options.phrase,
          options.perPage,
          after,
        ),
      options.retryConfig,
      options.retryDisabled,
      options.logger,
      `Fetching audit log after ${after ?? 'start'}`,
    );
    entries.push(...page.entries);

    if (page.nextCursor && seenCursors.has(page.nextCursor)) {
      throw new Error(
        `GitHub returned the repeated audit log cursor "${page.nextCursor}"`,
      );
    }
    after = page.nextCursor;
    if (after) {
      seenCursors.add(after);
    }
  } while (after);

  return entries;
}

export function writeRepoRenameCsv(
  outputFile: string,
  records: RepoRenameRecord[],
): void {
  const directory = path.dirname(outputFile);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = path.join(
    directory,
    `.${path.basename(outputFile)}.${randomUUID()}.tmp`,
  );
  const rows = [
    HEADERS.join(','),
    ...records.map((record) =>
      HEADERS.map((header) =>
        escapeCsvValue(sanitizeCsvFormulaValue(record[header])),
      ).join(','),
    ),
  ];

  try {
    fs.writeFileSync(temporaryFile, `${rows.join('\n')}\n`, 'utf8');
    fs.renameSync(temporaryFile, outputFile);
  } finally {
    if (fs.existsSync(temporaryFile)) {
      fs.unlinkSync(temporaryFile);
    }
  }
}

const listAuditLogRepoRenamesCommand = createCommandWithSharedOptions(
  'list-audit-log-repo-renames',
)
  .description(
    'Export distinct repository rename events from an organization audit log',
  )
  .addOption(
    new Option(
      '--start-date <date>',
      'Inclusive UTC start date in YYYY-MM-DD format',
    ).env('AUDIT_LOG_START_DATE'),
  )
  .addOption(
    new Option(
      '--end-date <date>',
      'Inclusive UTC end date in YYYY-MM-DD format',
    ).env('AUDIT_LOG_END_DATE'),
  )
  .addOption(
    new Option('--force [boolean]', 'Replace an existing output file')
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .addHelpText(
    'after',
    `
Defaults to repo-renames.csv. Requires an organization owner token with access
to the organization audit log. Classic PATs typically need the admin:org scope;
fine-grained tokens need read access to organization Administration.
`,
  )
  .action(async (options) => {
    if (!options.orgName) {
      throw new Error('An organization is required through --org-name');
    }
    const pageSize = validatePageSize(options.pageSize);

    const dateRange = validateDateRange({
      startDate: options.startDate,
      endDate: options.endDate,
    });
    const phrase = buildAuditLogPhrase(dateRange);
    const outputFile = ensureOutputPathWritable(
      options.outputFile ?? 'repo-renames.csv',
      options.force,
    );
    const retryDisabled = options.retryDisabled;
    const retryConfig = retryConfigFromOptions(options);

    await executeWithOctokit(
      { ...options, retryDisabled: true },
      async ({ octokit, logger }) => {
        const entries = await fetchRepoRenameEntries({
          octokit,
          organization: options.orgName,
          phrase,
          perPage: pageSize,
          retryConfig,
          retryDisabled,
          logger,
        });
        const { records, skipped } = parseRepoRenameEntries(entries);

        if (skipped > 0) {
          logger.warn(
            `Skipped ${skipped} repository rename event(s) with missing or invalid fields`,
          );
        }

        writeRepoRenameCsv(outputFile, records);
        logger.info(
          `Exported ${records.length} distinct repository rename event(s) to ${outputFile}`,
        );
      },
    );
  });

export default listAuditLogRepoRenamesCommand;

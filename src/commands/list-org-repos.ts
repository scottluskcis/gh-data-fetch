import {
  executeWithOctokit,
  type Logger,
  type RetryConfig,
} from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import type { Octokit } from 'octokit';
import { executeApiOperation } from '../utils/api-operation.js';
import { type CsvExport, createCsvExport } from '../utils/csv.js';
import { errorMessage } from '../utils/errors.js';
import { resolveOrganizations } from '../utils/github-input.js';
import {
  collectOption,
  createCommandWithSharedOptions,
  parseBooleanOption,
  retryConfigFromOptions,
} from './command-helpers.js';

const HEADERS = [
  'api_base_url',
  'organization_login',
  'repository_name',
  'repository_full_name',
  'repository_url',
  'description',
  'created_at',
  'updated_at',
  'pushed_at',
  'visibility',
  'archived',
  'disabled',
  'fork',
  'is_template',
  'default_branch',
  'disk_size_kib',
  'primary_language',
  'is_locked',
  'lock_reason',
  'is_locked_for_migration',
  'migration_status',
  'migration_issue',
  'custom_properties_json',
  'coverage_status',
  'unsupported_fields',
  'collection_errors',
  'collected_at',
];

interface RepositoryData {
  node_id: string;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  visibility?: string;
  private: boolean;
  archived?: boolean;
  disabled?: boolean;
  fork: boolean;
  is_template?: boolean;
  default_branch?: string;
  size?: number;
  language?: string | null;
  custom_properties?: Record<string, unknown>;
}

interface LockData {
  isLocked: boolean;
  lockReason: string | null;
}

interface LockResponse {
  nodes: (({ id: string; nameWithOwner: string } & LockData) | null)[];
}

export interface ProcessContext {
  octokit: Octokit;
  logger: Logger;
  retryConfig: RetryConfig;
  retryDisabled: boolean;
  output: CsvExport;
  migrationStatusProperty: string;
  migrationIssueProperty: string;
  baseUrl: string;
}

const LOCK_QUERY = `query RepositoryLocks($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Repository {
      id
      nameWithOwner
      isLocked
      lockReason
    }
  }
}`;

export function isLockedForMigration(
  lock: LockData | undefined,
): boolean | undefined {
  if (!lock) {
    return undefined;
  }
  return lock.isLocked && lock.lockReason === 'MIGRATING';
}

export function customPropertyDisplayValue(
  value: unknown,
): string | number | boolean | null | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

async function fetchLocks(
  context: ProcessContext,
  repositories: RepositoryData[],
): Promise<{ values: Map<string, LockData>; error?: string }> {
  const values = new Map<string, LockData>();
  if (repositories.length === 0) {
    return { values };
  }

  try {
    const response = await executeApiOperation(
      () =>
        context.octokit.graphql<LockResponse>(LOCK_QUERY, {
          ids: repositories.map(({ node_id }) => node_id),
        }),
      context.retryConfig,
      context.retryDisabled,
      context.logger,
      `Fetching lock state for ${repositories[0].full_name}`,
    );
    for (const repository of response.nodes) {
      if (repository) {
        values.set(repository.nameWithOwner.toLowerCase(), repository);
      }
    }
    return { values };
  } catch (error: unknown) {
    return { values, error: errorMessage(error) };
  }
}

export async function processOrganization(
  context: ProcessContext,
  organization: string,
): Promise<string[]> {
  const failures: string[] = [];
  let page = 1;

  try {
    while (true) {
      const response = await executeApiOperation(
        () =>
          context.octokit.request('GET /orgs/{org}/repos', {
            org: organization,
            page,
            per_page: 100,
            type: 'all',
            sort: 'full_name',
            direction: 'asc',
          }),
        context.retryConfig,
        context.retryDisabled,
        context.logger,
        `Fetching repositories for ${organization}, page ${page}`,
      );
      const repositories = response.data as RepositoryData[];
      const locks = await fetchLocks(context, repositories);
      if (locks.error) {
        failures.push(locks.error);
        context.output.appendError({
          scope: 'page',
          organization,
          page_or_cursor: page,
          operation: 'fetch-repository-locks',
          message: locks.error,
        });
      }

      for (const repository of repositories) {
        const hasCustomProperties = Object.prototype.hasOwnProperty.call(
          repository,
          'custom_properties',
        );
        const properties = repository.custom_properties ?? {};
        const lock = locks.values.get(repository.full_name.toLowerCase());
        const unsupportedFields = hasCustomProperties
          ? []
          : ['custom_properties'];
        const collectionErrors = locks.error
          ? [`repository_lock: ${locks.error}`]
          : [];

        context.output.append({
          api_base_url: context.baseUrl,
          organization_login: organization,
          repository_name: repository.name,
          repository_full_name: repository.full_name,
          repository_url: repository.html_url,
          description: repository.description,
          created_at: repository.created_at,
          updated_at: repository.updated_at,
          pushed_at: repository.pushed_at,
          visibility:
            repository.visibility ??
            (repository.private ? 'private' : 'public'),
          archived: repository.archived,
          disabled: repository.disabled,
          fork: repository.fork,
          is_template: repository.is_template,
          default_branch: repository.default_branch,
          disk_size_kib: repository.size,
          primary_language: repository.language,
          is_locked: lock?.isLocked,
          lock_reason: lock?.lockReason,
          is_locked_for_migration: isLockedForMigration(lock),
          migration_status: customPropertyDisplayValue(
            properties[context.migrationStatusProperty],
          ),
          migration_issue: customPropertyDisplayValue(
            properties[context.migrationIssueProperty],
          ),
          custom_properties_json: stableJson(properties),
          coverage_status:
            unsupportedFields.length === 0 && collectionErrors.length === 0
              ? 'complete'
              : 'partial',
          unsupported_fields: unsupportedFields.join(';'),
          collection_errors: collectionErrors.join(';'),
          collected_at: new Date().toISOString(),
        });
      }

      if (repositories.length < 100) {
        break;
      }
      page++;
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    failures.push(message);
    context.output.appendError({
      scope: 'organization',
      organization,
      page_or_cursor: page,
      operation: 'list-organization-repositories',
      message,
    });
  }

  return failures;
}

const listOrgReposCommand = createCommandWithSharedOptions('list-org-repos')
  .description(
    'Export migration-focused repository inventory for one or more organizations',
  )
  .addOption(
    new Option('--org <slug>', 'Organization slug; repeat for multiple')
      .env('ORGANIZATIONS')
      .argParser(collectOption)
      .default([]),
  )
  .addOption(
    new Option('--org-file <file>', 'Newline or CSV organization input').env(
      'ORG_FILE',
    ),
  )
  .addOption(
    new Option(
      '--migration-status-property <name>',
      'Custom property used for migration status',
    )
      .env('MIGRATION_STATUS_PROPERTY')
      .default('migration-status'),
  )
  .addOption(
    new Option(
      '--migration-issue-property <name>',
      'Custom property used for migration issue tracking',
    )
      .env('MIGRATION_ISSUE_PROPERTY')
      .default('migration-issue'),
  )
  .addOption(
    new Option('--force [boolean]', 'Replace an existing output and error file')
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .addHelpText(
    'after',
    `
Requires --output-file and at least one organization source. Repositories are
written as they are fetched. Partial API failures keep completed rows, write
<output-file>.errors.csv, and exit nonzero.
`,
  )
  .action(async (options) => {
    if (!options.outputFile) {
      throw new Error('An output path is required through --output-file');
    }
    const organizations = resolveOrganizations(
      options.org ?? [],
      options.orgFile,
      options.orgName,
    );
    const output = createCsvExport({
      outputFile: options.outputFile,
      headers: HEADERS,
      force: options.force,
    });
    const retryDisabled = options.retryDisabled;
    const retryConfig = retryConfigFromOptions(options);

    await executeWithOctokit(
      { ...options, retryDisabled: true },
      async ({ octokit, logger, opts }) => {
        const context: ProcessContext = {
          octokit,
          logger,
          retryConfig,
          retryDisabled,
          output,
          migrationStatusProperty: options.migrationStatusProperty,
          migrationIssueProperty: options.migrationIssueProperty,
          baseUrl: opts.baseUrl,
        };
        const failures: string[] = [];

        for (const organization of organizations) {
          failures.push(...(await processOrganization(context, organization)));
        }

        if (failures.length > 0) {
          throw new Error(
            `Repository export completed with ${failures.length} partial failure(s); see ${output.errorFile}`,
          );
        }

        logger.info(`Exported repository inventory to ${output.outputFile}`);
      },
    );
  });

export default listOrgReposCommand;

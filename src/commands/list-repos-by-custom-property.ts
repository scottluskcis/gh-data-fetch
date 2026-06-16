import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import fs from 'fs';
import path from 'path';
import { initializeCsvFile } from '../utils/csv.js';
import { fetchRepoMaintainers } from '../utils/repo-maintainers.js';
import { createCommandWithSharedOptions } from './command-helpers.js';

interface Repository {
  name: string;
  url: string;
  visibility: string;
  createdAt?: string;
  updatedAt?: string;
  lastPush?: string;
  migrationStatus?: string;
  migrationIssue?: string;
  archived?: boolean;
  maintainers?: string[];
  securityMaintainers?: string;
}

const csvHeaders = [
  'Organization',
  'Repository Name',
  'Visibility',
  'Created At',
  'Updated At',
  'Last Push',
  'Migration Status',
  'Migration Issue',
  'Is Archived',
  'Repository URL',
  'Admins or Maintainers',
  'Security Maintainers',
].join(',');

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(org: string, repo: Repository): string {
  return [
    org,
    repo.name,
    repo.visibility,
    repo.createdAt ?? '',
    repo.updatedAt ?? '',
    repo.lastPush ?? '',
    repo.migrationStatus ?? '',
    repo.migrationIssue ?? '',
    repo.archived ? 'true' : 'false',
    repo.url,
    (repo.maintainers ?? []).join(';'),
    repo.securityMaintainers ?? '',
  ]
    .map(escapeCsvField)
    .join(',');
}

async function* fetchReposByCustomProperty(
  customPropertyName: string,
  customPropertyValue: string,
  customPropertyComparison: 'equals' | 'not-equals' = 'equals',
  octokit: any,
  organization: string,
  logger: any,
  teamMembersCache: Map<string, string[]>,
  excludeTeams: Set<string>,
  pageSize = 100,
): AsyncGenerator<Repository, void, unknown> {
  try {
    const reposIterator = octokit.paginate.iterator('/orgs/{org}/repos', {
      org: organization,
      per_page: pageSize,
    });

    for await (const { data: repos } of reposIterator) {
      for (const repo of repos as any[]) {
        logger.info(
          `Checking repo: ${repo.name} for property ${customPropertyName}...`,
        );

        const propertyValue = repo.custom_properties?.[customPropertyName];
        const isMatch =
          customPropertyComparison === 'equals'
            ? `${propertyValue}`.toLowerCase().trim() ===
              `${customPropertyValue}`.toLowerCase().trim()
            : `${propertyValue}`.toLowerCase().trim() !==
              `${customPropertyValue}`.toLowerCase().trim();
        if (isMatch) {
          logger.info(
            `Repo ${repo.name} matches the criteria with ${customPropertyName}=${customPropertyValue}`,
          );
          const maintainers = await fetchRepoMaintainers(
            octokit,
            organization,
            repo.name,
            teamMembersCache,
            logger,
            excludeTeams,
            'all',
            'all',
            12,
          );
          yield {
            name: repo.name,
            url: repo.html_url,
            visibility: repo.visibility,
            createdAt: repo.created_at ?? '',
            updatedAt: repo.updated_at ?? '',
            lastPush: repo.pushed_at ?? '',
            migrationStatus: repo.custom_properties?.['migration-status'] ?? '',
            migrationIssue: repo.custom_properties?.['migration-issue'] ?? '',
            archived: repo.archived,
            maintainers,
            securityMaintainers:
              repo.custom_properties?.['security-maintainers'] ?? '',
          };
        }
      }
    }
  } catch (error: any) {
    logger.error(`Error fetching repos: ${error.message}`);
    if (error.status === 404) {
      logger.warn(
        `Organization ${organization} not found or info not accessible`,
      );
    }
  }
}

const listReposByCustomPropertyCommand = createCommandWithSharedOptions(
  'list-repos-by-custom-property',
)
  .description('List repositories that have a specific custom property value')
  .addOption(
    new Option(
      '--custom-property-name <name>',
      'The name of the custom property to filter by',
    )
      .env('CUSTOM_PROPERTY_NAME')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--custom-property-value <value>',
      'The value of the custom property to filter by',
    )
      .env('CUSTOM_PROPERTY_VALUE')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--custom-property-comparison <comparison>',
      'Comparison type for custom property value (equals or not-equals)',
    )
      .env('CUSTOM_PROPERTY_COMPARISON')
      .choices(['equals', 'not-equals'])
      .default('equals'),
  )
  .addOption(
    new Option(
      '--csv-output <path>',
      'Path to output CSV file (will be created if it does not exist)',
    )
      .env('CSV_OUTPUT')
      .default('./output/repos-by-custom-property.csv'),
  )
  .addOption(
    new Option(
      '--exclude-teams <teams>',
      'Comma-separated list of team names to exclude maintainers from',
    ).env('EXCLUDE_TEAMS'),
  )
  .action(async (options) => {
    await executeWithOctokit(options, async ({ octokit, logger, opts }) => {
      logger.info('Starting...');

      // Parse comma-separated organization names
      const organizations = opts.orgName
        .split(',')
        .map((org: string) => org.trim());

      // Parse excluded teams
      const excludeTeams = new Set<string>(
        options.excludeTeams
          ? options.excludeTeams
              .split(',')
              .map((t: string) => t.trim().toLowerCase())
              .filter((t: string) => t.length > 0)
          : [],
      );

      // Create CSV output file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const parsed = path.parse(path.resolve(options.csvOutput));
      const csvOutput = path.join(
        parsed.dir,
        `${parsed.name}-${timestamp}${parsed.ext}`,
      );
      initializeCsvFile(csvOutput, csvHeaders.split(','));
      logger.info(`Created CSV file with headers at ${csvOutput}`);

      for (const org of organizations) {
        logger.info(`Checking organization: ${org}`);

        const teamMembersCache = new Map<string, string[]>();
        try {
          for await (const repoWithPages of fetchReposByCustomProperty(
            options.customPropertyName,
            options.customPropertyValue,
            options.customPropertyComparison,
            octokit,
            org,
            logger,
            teamMembersCache,
            excludeTeams,
            100,
          )) {
            logger.info(`Repo with Custom Property: ${repoWithPages.name}`);
            fs.appendFileSync(csvOutput, toCsvRow(org, repoWithPages) + '\n');
          }
        } catch (error: any) {
          logger.error(
            `Error processing organization ${org}: ${error.message}`,
          );
        }
      }
    });
  });

export default listReposByCustomPropertyCommand;

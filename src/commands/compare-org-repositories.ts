import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { Option } from 'commander';
import { Octokit } from 'octokit';
import path from 'path';
import { appendRecordToCsv, initializeCsvFile } from '../utils/csv.js';
import { createCommandWithSharedOptions } from './command-helpers.js';

type OrganizationRepository =
  RestEndpointMethodTypes['repos']['listForOrg']['response']['data'][number];

type Repository = Pick<
  OrganizationRepository,
  'name' | 'html_url' | 'visibility' | 'archived' | 'created_at' | 'updated_at'
>;

interface OrganizationLocation {
  name: string;
  url: string;
}

interface Logger {
  info(message: string): void;
}

const csvHeaders = [
  'Source Organization URL',
  'Source Organization',
  'Comparison Organization URL',
  'Comparison Organization',
  'Source Repository Name',
  'Exists in Comparison',
  'Source Repository URL',
  'Source Visibility',
  'Source Archived',
  'Source Created At',
  'Source Updated At',
  'Comparison Repository Name',
  'Comparison Repository URL',
  'Comparison Visibility',
  'Comparison Archived',
  'Comparison Created At',
  'Comparison Updated At',
];

export function parseOrganizationUrl(value: string): OrganizationLocation {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid organization URL: ${value}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Organization URL must use HTTPS: ${value}`);
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `Organization URL must not include credentials, query parameters, or a fragment: ${value}`,
    );
  }

  const pathSegments = url.pathname.split('/').filter(Boolean);
  if (pathSegments.length !== 1) {
    throw new Error(
      `Organization URL must contain exactly one organization path segment: ${value}`,
    );
  }

  let name: string;
  try {
    name = decodeURIComponent(pathSegments[0]);
  } catch {
    throw new Error(`Invalid organization URL path: ${value}`);
  }

  if (!name || name.includes('/') || name.trim() !== name) {
    throw new Error(`Invalid organization name in URL: ${value}`);
  }

  return {
    name,
    url: `${url.origin}/${encodeURIComponent(name)}`,
  };
}

export async function listOrganizationRepositories(
  octokit: Octokit,
  organization: string,
): Promise<Repository[]> {
  const repositories: Repository[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.repos.listForOrg, {
    org: organization,
    per_page: 100,
    type: 'all',
  });

  for await (const response of iterator) {
    repositories.push(...response.data);
  }

  return repositories;
}

function getErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }

  return undefined;
}

export async function findComparisonRepositories(
  octokit: Octokit,
  organization: string,
  sourceRepositories: Repository[],
  concurrency = 10,
): Promise<Map<string, Repository>> {
  const repositoriesByName = new Map<string, Repository>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < sourceRepositories.length) {
      const repository = sourceRepositories[nextIndex++];

      try {
        const response = await octokit.rest.repos.get({
          owner: organization,
          repo: repository.name,
        });
        repositoriesByName.set(response.data.name.toLowerCase(), response.data);
      } catch (error: unknown) {
        if (getErrorStatus(error) !== 404) {
          throw error;
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, sourceRepositories.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return repositoriesByName;
}

function buildCsvRecord(
  sourceOrg: OrganizationLocation,
  compareOrg: OrganizationLocation,
  sourceRepository: Repository,
  compareRepository: Repository | undefined,
): Record<string, unknown> {
  return {
    'Source Organization URL': sourceOrg.url,
    'Source Organization': sourceOrg.name,
    'Comparison Organization URL': compareOrg.url,
    'Comparison Organization': compareOrg.name,
    'Source Repository Name': sourceRepository.name,
    'Exists in Comparison': Boolean(compareRepository),
    'Source Repository URL': sourceRepository.html_url,
    'Source Visibility': sourceRepository.visibility ?? '',
    'Source Archived': sourceRepository.archived,
    'Source Created At': sourceRepository.created_at,
    'Source Updated At': sourceRepository.updated_at,
    'Comparison Repository Name': compareRepository?.name ?? '',
    'Comparison Repository URL': compareRepository?.html_url ?? '',
    'Comparison Visibility': compareRepository?.visibility ?? '',
    'Comparison Archived': compareRepository?.archived ?? '',
    'Comparison Created At': compareRepository?.created_at ?? '',
    'Comparison Updated At': compareRepository?.updated_at ?? '',
  };
}

const compareOrgRepositoriesCommand = createCommandWithSharedOptions(
  'compare-org-repositories',
)
  .description(
    'Compare repositories in one GitHub organization with another organization',
  )
  .addOption(
    new Option('--source-org-url <url>', 'Full URL of the source organization')
      .env('SOURCE_ORG_URL')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--compare-org-url <url>',
      'Full URL of the comparison organization',
    )
      .env('COMPARE_ORG_URL')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--compare-base-url <url>',
      'GitHub API base URL for the comparison organization',
    )
      .env('COMPARE_BASE_URL')
      .default('https://api.github.com'),
  )
  .addOption(
    new Option(
      '--compare-access-token <token>',
      'GitHub access token for the comparison organization',
    )
      .env('COMPARE_ACCESS_TOKEN')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--csv-output <path>', 'Path to write the comparison CSV')
      .env('CSV_OUTPUT')
      .default('./output/repository-comparison.csv'),
  )
  .action(async (options) => {
    if (!options.accessToken) {
      throw new Error(
        'A source access token is required through --access-token or ACCESS_TOKEN',
      );
    }

    const sourceOrg = parseOrganizationUrl(options.sourceOrgUrl);
    const compareOrg = parseOrganizationUrl(options.compareOrgUrl);
    const compareOctokit = new Octokit({
      auth: options.compareAccessToken,
      baseUrl: options.compareBaseUrl,
    });
    const sourceOptions = { ...options };
    delete sourceOptions.compareAccessToken;

    let sourceRepositories: Repository[] | undefined;
    let commandLogger: Logger | undefined;

    await executeWithOctokit(sourceOptions, async ({ octokit, logger }) => {
      logger.info(
        `Fetching repositories from source organization ${sourceOrg.name}...`,
      );
      sourceRepositories = await listOrganizationRepositories(
        octokit,
        sourceOrg.name,
      );
      commandLogger = logger;
    });

    if (!sourceRepositories || !commandLogger) {
      throw new Error('Source repository retrieval did not complete');
    }

    commandLogger.info(
      `Checking ${sourceRepositories.length} repository names in comparison organization ${compareOrg.name}...`,
    );
    const compareRepositoriesByName = await findComparisonRepositories(
      compareOctokit,
      compareOrg.name,
      sourceRepositories,
    );

    sourceRepositories.sort((left, right) =>
      left.name.localeCompare(right.name, 'en-US', {
        sensitivity: 'base',
      }),
    );

    const csvOutput = path.resolve(options.csvOutput);
    initializeCsvFile(csvOutput, csvHeaders);

    let matchingRepositories = 0;
    for (const sourceRepository of sourceRepositories) {
      const compareRepository = compareRepositoriesByName.get(
        sourceRepository.name.toLowerCase(),
      );
      if (compareRepository) {
        matchingRepositories++;
      }

      appendRecordToCsv(
        csvOutput,
        buildCsvRecord(
          sourceOrg,
          compareOrg,
          sourceRepository,
          compareRepository,
        ),
        csvHeaders,
      );
    }

    commandLogger.info(
      `Exported ${sourceRepositories.length} source repositories to ${csvOutput}; ${matchingRepositories} exist in the comparison organization`,
    );
  });

export default compareOrgRepositoriesCommand;

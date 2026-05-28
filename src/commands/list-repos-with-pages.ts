import {
  createBaseCommand,
  executeWithOctokit,
} from '@scottluskcis/octokit-harness';
import fs from 'fs';
import path from 'path';
import { initializeCsvFile } from '../utils/csv.js';
import { fetchRepoMaintainers } from '../utils/repo-maintainers.js';

interface PagesInfo {
  htmlUrl: string;
  status: string | null;
  buildType: string;
  sourceBranch: string;
  sourcePath: string;
  cname: string | null;
  httpsEnforced: boolean;
  public: boolean;
  protectedDomainState: string | null;
}

interface Repository {
  name: string;
  url: string;
  visibility: string;
  migrationStatus?: string;
  migrationIssue?: string;
  archived?: boolean;
  pagesInfo?: PagesInfo;
  maintainers?: string[];
}

const csvHeaders = [
  'Organization',
  'Repository Name',
  'Visibility',
  'Migration Status',
  'Migration Issue',
  'Is Archived',
  'Pages HTML URL',
  'Pages Status',
  'Pages Build Type',
  'Pages Source Branch',
  'Pages Source Path',
  'Pages CNAME',
  'Pages HTTPS Enforced',
  'Pages Public',
  'Pages Protected Domain State',
  'Repository URL',
  'Maintainers',
].join(',');

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(org: string, repo: Repository): string {
  const info = repo.pagesInfo;
  return [
    org,
    repo.name,
    repo.visibility,
    repo.migrationStatus ?? '',
    repo.migrationIssue ?? '',
    repo.archived ? 'true' : 'false',
    info?.htmlUrl ?? '',
    info?.status ?? '',
    info?.buildType ?? '',
    info?.sourceBranch ?? '',
    info?.sourcePath ?? '',
    info?.cname ?? '',
    info?.httpsEnforced ? 'true' : 'false',
    info?.public ? 'true' : 'false',
    info?.protectedDomainState ?? '',
    repo.url,
    (repo.maintainers ?? []).join(';'),
  ]
    .map(escapeCsvField)
    .join(',');
}

async function* getReposWithPages(
  octokit: any,
  organization: string,
  logger: any,
  teamMembersCache: Map<string, string[]>,
  pageSize: number = 100,
): AsyncGenerator<Repository, void, unknown> {
  try {
    const reposIterator = octokit.paginate.iterator('/orgs/{org}/repos', {
      org: organization,
      per_page: pageSize,
    });

    for await (const { data: repos } of reposIterator) {
      for (const repo of repos as any[]) {
        if (repo.has_pages) {
          logger.info(
            `Found repo with pages: ${repo.name}, fetching pages info...`,
          );
          try {
            const { data: pages } = await octokit.request(
              'GET /repos/{owner}/{repo}/pages',
              {
                owner: organization,
                repo: repo.name,
              },
            );

            const maintainers = await fetchRepoMaintainers(
              octokit,
              organization,
              repo.name,
              teamMembersCache,
              logger,
            );

            yield {
              name: repo.name,
              url: repo.html_url,
              visibility: repo.visibility,
              migrationStatus:
                repo.custom_properties?.['migration-status'] ?? '',
              migrationIssue: repo.custom_properties?.['migration-issue'] ?? '',
              archived: repo.archived,
              pagesInfo: {
                htmlUrl: pages.html_url ?? '',
                status: pages.status ?? null,
                buildType: pages.build_type ?? '',
                sourceBranch: pages.source?.branch ?? '',
                sourcePath: pages.source?.path ?? '',
                cname: pages.cname ?? null,
                httpsEnforced: pages.https_enforced ?? false,
                public: pages.public ?? false,
                protectedDomainState: pages.protected_domain_state ?? null,
              },
              maintainers,
            };
          } catch (error: any) {
            logger.warn(`Skipping repo ${repo.name}: ${error.message}`);
          }
        }
      }
    }
  } catch (error: any) {
    logger.error(`Error fetching repos: ${error.message}`);
    if (error.status === 404) {
      logger.warn(
        `Organization ${organization} not found or pages info not accessible`,
      );
    }
  }
}

const listReposWithPagesCommand = createBaseCommand({
  name: 'list-repos-with-pages',
  description: 'List any repos that use GitHub Pages',
})
  .option(
    '--csv-output <csvOutput>',
    'Path to write CSV output file',
    './output/repos-with-pages.csv',
  )
  .action(async (options) => {
    await executeWithOctokit(options, async ({ octokit, logger, opts }) => {
      logger.info('Starting to collect repos using GitHub Pages...');

      // Parse comma-separated organization names
      const organizations = opts.orgName
        .split(',')
        .map((org: string) => org.trim());

      // Create CSV output file
      const csvOutput = path.resolve(options.csvOutput);
      initializeCsvFile(csvOutput, csvHeaders.split(','));
      logger.info(`Created CSV file with headers at ${csvOutput}`);

      for (const org of organizations) {
        logger.info(`Checking organization: ${org}`);

        const teamMembersCache = new Map<string, string[]>();
        try {
          for await (const repoWithPages of getReposWithPages(
            octokit,
            org,
            logger,
            teamMembersCache,
          )) {
            logger.info(`Repo with Pages: ${repoWithPages.name}`);
            fs.appendFileSync(csvOutput, toCsvRow(org, repoWithPages) + '\n');
          }
        } catch (error: any) {
          logger.error(
            `Error processing organization ${org}: ${error.message}`,
          );
        }
      }

      logger.info('Finished');
    });
  });

export default listReposWithPagesCommand;

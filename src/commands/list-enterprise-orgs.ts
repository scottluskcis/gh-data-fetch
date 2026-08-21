import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import { executeApiOperation } from '../utils/api-operation.js';
import { errorMessage } from '../utils/errors.js';
import { createInventoryOutput } from '../utils/inventory-output.js';
import {
  createCommandWithSharedOptions,
  parseBooleanOption,
  retryConfigFromOptions,
} from './command-helpers.js';

const HEADERS = [
  'enterprise_slug',
  'api_base_url',
  'organization_login',
  'organization_name',
  'organization_url',
  'description',
  'created_at',
  'updated_at',
  'repository_count',
  'viewer_can_administer',
  'collected_at',
];

interface OrganizationNode {
  login: string;
  name: string | null;
  url: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  repositories: { totalCount: number };
  viewerCanAdminister: boolean;
}

interface OrganizationsResponse {
  enterprise: {
    organizations: {
      nodes: OrganizationNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

const ORGANIZATIONS_QUERY = `query EnterpriseOrganizations($slug: String!, $cursor: String) {
  enterprise(slug: $slug) {
    organizations(first: 100, after: $cursor) {
      nodes {
        login
        name
        url
        description
        createdAt
        updatedAt
        repositories { totalCount }
        viewerCanAdminister
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const listEnterpriseOrgsCommand = createCommandWithSharedOptions(
  'list-enterprise-orgs',
)
  .description('Export enterprise organizations to CSV')
  .addOption(
    new Option('--enterprise-slug <slug>', 'Enterprise account slug')
      .env('ENTERPRISE_SLUG')
      .makeOptionMandatory(),
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
Requires --output-file. A classic PAT with repo, admin:org, and read:enterprise
scopes is recommended for complete private inventory. Partial API failures keep
completed rows, write <output-file>.errors.csv, and exit nonzero.
`,
  )
  .action(async (options) => {
    if (!options.outputFile) {
      throw new Error('An output path is required through --output-file');
    }

    const output = createInventoryOutput({
      outputFile: options.outputFile,
      headers: HEADERS,
      force: options.force,
    });
    const retryDisabled = options.retryDisabled;
    const retryConfig = retryConfigFromOptions(options);

    await executeWithOctokit(
      { ...options, retryDisabled: true },
      async ({ octokit, logger, opts }) => {
        let cursor: string | null = null;
        let total = 0;

        try {
          do {
            const response: OrganizationsResponse = await executeApiOperation(
              () =>
                octokit.graphql<OrganizationsResponse>(ORGANIZATIONS_QUERY, {
                  slug: options.enterpriseSlug,
                  cursor,
                }),
              retryConfig,
              retryDisabled,
              logger,
              `Fetching enterprise organizations after ${cursor ?? 'start'}`,
            );
            if (!response.enterprise) {
              throw new Error(
                `Enterprise "${options.enterpriseSlug}" was not found or is not accessible`,
              );
            }

            for (const organization of response.enterprise.organizations
              .nodes) {
              output.append({
                enterprise_slug: options.enterpriseSlug,
                api_base_url: opts.baseUrl,
                organization_login: organization.login,
                organization_name: organization.name,
                organization_url: organization.url,
                description: organization.description,
                created_at: organization.createdAt,
                updated_at: organization.updatedAt,
                repository_count: organization.repositories.totalCount,
                viewer_can_administer: organization.viewerCanAdminister,
                collected_at: new Date().toISOString(),
              });
              total++;
            }

            const pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            } = response.enterprise.organizations.pageInfo;
            cursor = pageInfo.endCursor;
            if (!pageInfo.hasNextPage) {
              break;
            }
          } while (cursor);
        } catch (error: unknown) {
          output.appendError({
            scope: 'enterprise',
            organization: '',
            page_or_cursor: cursor,
            operation: 'list-enterprise-organizations',
            message: errorMessage(error),
          });
          throw error;
        }

        logger.info(`Exported ${total} organizations to ${output.outputFile}`);
      },
    );
  });

export default listEnterpriseOrgsCommand;

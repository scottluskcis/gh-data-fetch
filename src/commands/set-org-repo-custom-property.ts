import {
  executeWithOctokit,
  type Logger,
  type RetryConfig,
  withRetry,
} from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import fs from 'fs';
import {
  chunkRepositoryNames,
  parseRepositoryList,
  resolveCustomPropertyValue,
  selectRepositoryNames,
} from '../utils/custom-properties.js';
import { createCommandWithSharedOptions } from './command-helpers.js';

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeApiOperation<T>(
  operation: () => Promise<T>,
  retryConfig: RetryConfig,
  retryDisabled: boolean,
  logger: Logger,
  description: string,
): Promise<T> {
  if (retryDisabled) {
    return operation();
  }

  return withRetry(operation, retryConfig, (state) => {
    logger.warn(
      `${description} failed (attempt ${state.attempt}); retrying: ${state.error?.message ?? 'Unknown error'}`,
    );
  });
}

const setOrgRepoCustomPropertyCommand = createCommandWithSharedOptions(
  'set-org-repo-custom-property',
)
  .description(
    'Set one custom property value across all or selected organization repositories',
  )
  .addOption(
    new Option('--property-name <name>', 'Custom property name')
      .env('CUSTOM_PROPERTY_NAME')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--property-value <value>', 'Custom property string value')
      .env('CUSTOM_PROPERTY_VALUE')
      .conflicts('clear'),
  )
  .addOption(
    new Option('--clear', 'Unset the custom property value on each repository')
      .env('CLEAR_CUSTOM_PROPERTY_VALUE')
      .conflicts('propertyValue'),
  )
  .action(async (options) => {
    if (!options.orgName) {
      throw new Error(
        'An organization is required through --org-name or ORG_NAME',
      );
    }

    const propertyValue = resolveCustomPropertyValue(
      options.propertyValue,
      options.clear,
    );
    const retryDisabled =
      options.retryDisabled === true || options.retryDisabled === 'true';
    const retryConfig: RetryConfig = {
      maxAttempts: options.retryMaxAttempts ?? 5,
      initialDelayMs: options.retryInitialDelay ?? 1000,
      maxDelayMs: options.retryMaxDelay ?? 30000,
      backoffFactor: options.retryBackoffFactor ?? 2,
      successThreshold: options.retrySuccessThreshold ?? 5,
    };

    await executeWithOctokit(
      { ...options, retryDisabled: true },
      async ({ octokit, logger, opts }) => {
        const organization = opts.orgName;
        let missingPropertyError: unknown;

        const propertySchema = await executeApiOperation(
          async () => {
            try {
              const response = await octokit.request(
                'GET /orgs/{org}/properties/schema/{custom_property_name}',
                {
                  org: organization,
                  custom_property_name: options.propertyName,
                },
              );
              return response.data;
            } catch (error: unknown) {
              if (getErrorStatus(error) === 404) {
                missingPropertyError = error;
                return undefined;
              }
              throw error;
            }
          },
          retryConfig,
          retryDisabled,
          logger,
          `Fetching custom property "${options.propertyName}"`,
        );

        if (!propertySchema) {
          throw new Error(
            `Custom property "${options.propertyName}" does not exist in ${organization}`,
            { cause: missingPropertyError },
          );
        }

        if (
          propertyValue !== null &&
          propertySchema.value_type === 'multi_select'
        ) {
          throw new Error(
            `Custom property "${options.propertyName}" requires an array value, which this command does not support`,
          );
        }

        const organizationRepositories: string[] = [];
        const repositoriesPerPage = 100;
        let page = 1;

        while (true) {
          const response = await executeApiOperation(
            () =>
              octokit.rest.repos.listForOrg({
                org: organization,
                page,
                per_page: repositoriesPerPage,
                type: 'all',
              }),
            retryConfig,
            retryDisabled,
            logger,
            `Fetching repository page ${page}`,
          );
          organizationRepositories.push(
            ...response.data.map((repository) => repository.name),
          );

          if (response.data.length < repositoriesPerPage) {
            break;
          }
          page++;
        }

        const requestedRepositories = options.repoList
          ? parseRepositoryList(
              fs.readFileSync(options.repoList, 'utf8'),
              organization,
            )
          : undefined;
        const repositoryNames = selectRepositoryNames(
          organizationRepositories,
          requestedRepositories,
        );

        if (repositoryNames.length === 0) {
          logger.info(
            `No repositories found in ${organization}; nothing to update`,
          );
          return;
        }

        logger.info(
          `Updating "${options.propertyName}" on ${repositoryNames.length} repositories in ${organization}`,
        );

        let updatedCount = 0;
        for (const repositoryBatch of chunkRepositoryNames(repositoryNames)) {
          try {
            await executeApiOperation(
              () =>
                octokit.request('PATCH /orgs/{org}/properties/values', {
                  org: organization,
                  repository_names: repositoryBatch,
                  properties: [
                    {
                      property_name: options.propertyName,
                      value: propertyValue,
                    },
                  ],
                }),
              retryConfig,
              retryDisabled,
              logger,
              `Updating repositories ${updatedCount + 1}-${updatedCount + repositoryBatch.length}`,
            );
            updatedCount += repositoryBatch.length;
          } catch (error: unknown) {
            logger.error(
              `Update failed after ${updatedCount} of ${repositoryNames.length} repositories: ${getErrorMessage(error)}`,
            );
            throw error;
          }
        }

        logger.info(
          `Updated "${options.propertyName}" on ${updatedCount} repositories in ${organization}`,
        );
      },
    );
  });

export default setOrgRepoCustomPropertyCommand;

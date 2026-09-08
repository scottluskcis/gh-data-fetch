import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import fs from 'fs';
import { executeApiOperation } from '../utils/api-operation.js';
import { createCsvExport } from '../utils/csv.js';
import {
  customPropertyDisplayValue,
  parseRepositoryList,
  resolvePropertyNames,
  selectPropertyValues,
  selectRepositoryNames,
} from '../utils/custom-properties.js';
import {
  collectOption,
  createCommandWithSharedOptions,
  parseBooleanOption,
  retryConfigFromOptions,
} from './command-helpers.js';

const HEADERS = [
  'organization_login',
  'repository_name',
  'property_name',
  'property_value',
];

const getOrgRepoCustomPropertiesCommand = createCommandWithSharedOptions(
  'get-org-repo-custom-properties',
)
  .description(
    'Get custom property values across all or selected organization repositories',
  )
  .addOption(
    new Option(
      '--property-name <name>',
      'Custom property name to include; repeat for multiple. Omit to include every property',
    )
      .env('CUSTOM_PROPERTY_NAMES')
      .argParser(collectOption)
      .default([]),
  )
  .addOption(
    new Option('--force [boolean]', 'Replace an existing output and error file')
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .action(async (options) => {
    if (!options.orgName) {
      throw new Error(
        'An organization is required through --org-name or ORG_NAME',
      );
    }
    if (!options.outputFile) {
      throw new Error('An output path is required through --output-file');
    }

    const requestedPropertyNames = resolvePropertyNames(
      options.propertyName ?? [],
    );
    const requestedRepositories = options.repoList
      ? parseRepositoryList(
          fs.readFileSync(options.repoList, 'utf8'),
          options.orgName,
        )
      : undefined;

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
        const organization = opts.orgName;

        if (requestedPropertyNames.length > 0) {
          const definitions = await executeApiOperation(
            async () => {
              const response = await octokit.request(
                'GET /orgs/{org}/properties/schema',
                { org: organization },
              );
              return response.data;
            },
            retryConfig,
            retryDisabled,
            logger,
            'Fetching custom property definitions',
          );

          const definedNames = new Set(
            definitions.map((definition) => definition.property_name),
          );
          const missingNames = requestedPropertyNames.filter(
            (name) => !definedNames.has(name),
          );
          if (missingNames.length > 0) {
            throw new Error(
              `Custom properties not found in ${organization}: ${missingNames.join(', ')}`,
            );
          }
        }

        const repositoryValues: {
          repository_name: string;
          properties: {
            property_name: string;
            value: string | string[] | null;
          }[];
        }[] = [];
        const repositoriesPerPage = 100;
        let page = 1;

        while (true) {
          const response = await executeApiOperation(
            () =>
              octokit.request('GET /orgs/{org}/properties/values', {
                org: organization,
                page,
                per_page: repositoriesPerPage,
              }),
            retryConfig,
            retryDisabled,
            logger,
            `Fetching custom property values page ${page}`,
          );
          repositoryValues.push(...response.data);

          if (response.data.length < repositoriesPerPage) {
            break;
          }
          page++;
        }

        const selectedRepositoryNames = selectRepositoryNames(
          repositoryValues.map((repository) => repository.repository_name),
          requestedRepositories,
        );
        const selectedNames = new Set(
          selectedRepositoryNames.map((name) => name.toLowerCase()),
        );

        let rowCount = 0;
        for (const repository of repositoryValues) {
          if (!selectedNames.has(repository.repository_name.toLowerCase())) {
            continue;
          }

          const properties = selectPropertyValues(
            repository.properties,
            requestedPropertyNames,
          );
          for (const property of properties) {
            output.append({
              organization_login: organization,
              repository_name: repository.repository_name,
              property_name: property.property_name,
              property_value: customPropertyDisplayValue(property.value),
            });
            rowCount++;
          }
        }

        logger.info(
          `Exported ${rowCount} custom property value(s) for ${selectedRepositoryNames.length} repositories in ${organization} to ${output.outputFile}`,
        );
      },
    );
  });

export default getOrgRepoCustomPropertiesCommand;

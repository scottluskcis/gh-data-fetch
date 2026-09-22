import {
  type Arguments,
  executeWithOctokit,
} from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import fs from 'fs';
import { executeApiOperation } from '../utils/api-operation.js';
import {
  ensureOutputPathWritable,
  escapeCsvValue,
  sanitizeCsvFormulaValue,
} from '../utils/csv.js';
import { errorMessage, errorStatus } from '../utils/errors.js';
import {
  createCommandWithSharedOptions,
  parseBooleanOption,
  retryConfigFromOptions,
} from './command-helpers.js';

const OUTPUT_FORMATS = ['csv', 'markdown'] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface GetUserRepoAccessOptions extends Arguments {
  username: string;
  repos?: string;
  repoList?: string;
  outputFormat: OutputFormat;
  outputFile?: string;
  force: boolean;
}

export interface RepositoryAccessResult {
  organization: string;
  repository: string;
  username: string;
  status: 'success' | 'error';
  hasAccess: 'yes' | 'no' | 'unknown';
  effectivePermission: string;
  role: string;
  routes: string[];
  attributionComplete: boolean;
  error: string;
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

export function parseRepositoryNames(
  organization: string,
  repositories?: string,
  fileContents?: string,
): string[] {
  const entries = [repositories ?? '', fileContents ?? '']
    .flatMap((value) => value.split(/[\r\n,]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const segments = value.split('/');
      if (segments.length === 1) {
        return segments[0];
      }
      if (
        segments.length === 2 &&
        segments[0].toLowerCase() === organization.toLowerCase() &&
        segments[1]
      ) {
        return segments[1];
      }
      throw new Error(
        `Invalid repository "${value}": expected a repository name or ${organization}/repository`,
      );
    });

  const resolved = uniqueCaseInsensitive(entries);
  if (resolved.length === 0) {
    throw new Error('Specify repositories with --repos or --repo-list');
  }
  return resolved;
}

function resultValues(result: RepositoryAccessResult): string[] {
  return [
    result.organization,
    result.repository,
    result.username,
    result.status,
    result.hasAccess,
    result.effectivePermission,
    result.role,
    result.routes.join('; '),
    result.attributionComplete ? 'yes' : 'no',
    result.error,
  ];
}

export function renderAccessCsv(results: RepositoryAccessResult[]): string {
  const headers = [
    'organization',
    'repository',
    'username',
    'status',
    'has_access',
    'effective_permission',
    'role',
    'access_routes',
    'attribution_complete',
    'error',
  ];
  const rows = results.map((result) =>
    resultValues(result)
      .map((value) => escapeCsvValue(sanitizeCsvFormulaValue(value)))
      .join(','),
  );
  return `${[headers.join(','), ...rows].join('\n')}\n`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

export function renderAccessMarkdown(
  results: RepositoryAccessResult[],
): string {
  const headers = [
    'Organization',
    'Repository',
    'Username',
    'Status',
    'Access',
    'Permission',
    'Role',
    'Routes',
    'Attribution complete',
    'Error',
  ];
  const rows = results.map(
    (result) => `| ${resultValues(result).map(escapeMarkdown).join(' | ')} |`,
  );
  return `${[
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows,
  ].join('\n')}\n`;
}

function defaultOutputFile(
  organization: string,
  username: string,
  format: OutputFormat,
): string {
  return `user-repo-access-${organization}-${username}.${format === 'markdown' ? 'md' : 'csv'}`;
}

const getUserRepoAccessCommand = createCommandWithSharedOptions(
  'get-user-repo-access',
)
  .description(
    "Report a user's effective role and access routes for organization repositories",
  )
  .addOption(
    new Option('--username <login>', 'GitHub user login to inspect')
      .env('GITHUB_USERNAME')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--repos <names>',
      'Comma-separated repository names or organization/repository values',
    ).env('REPOSITORIES'),
  )
  .addOption(
    new Option('--output-format <format>', 'Output format')
      .env('OUTPUT_FORMAT')
      .choices(OUTPUT_FORMATS)
      .default('csv'),
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
Requires repository metadata and organization members read access. Full route
attribution also requires access to repository collaborators and teams. A
classic token typically needs repo and read:org scopes.
`,
  )
  .action(async (options: GetUserRepoAccessOptions) => {
    if (!options.orgName) {
      throw new Error(
        'An organization is required through --org-name or ORG_NAME',
      );
    }

    const organization = options.orgName;
    const fileContents = options.repoList
      ? fs.readFileSync(options.repoList, 'utf8')
      : undefined;
    const repositories = parseRepositoryNames(
      organization,
      options.repos,
      fileContents,
    );
    const outputFile = ensureOutputPathWritable(
      options.outputFile ??
        defaultOutputFile(organization, options.username, options.outputFormat),
      options.force,
    );
    const retryDisabled = options.retryDisabled ?? false;
    const retryConfig = retryConfigFromOptions(options);
    const results: RepositoryAccessResult[] = [];

    await executeWithOctokit(
      { ...options, retryDisabled: true },
      async ({ octokit, logger }) => {
        await executeApiOperation(
          () =>
            octokit.request('GET /users/{username}', {
              username: options.username,
            }),
          retryConfig,
          retryDisabled,
          logger,
          `Validating user ${options.username}`,
        );

        let organizationMember = false;
        let organizationBasePermission = 'none';
        let organizationAttributionAvailable = true;

        try {
          const membership = await executeApiOperation(
            () =>
              octokit.request('GET /orgs/{org}/memberships/{username}', {
                org: organization,
                username: options.username,
              }),
            retryConfig,
            retryDisabled,
            logger,
            `Checking organization membership for ${options.username}`,
          );
          organizationMember = membership.data.state === 'active';
        } catch (error: unknown) {
          if (errorStatus(error) !== 404) {
            organizationAttributionAvailable = false;
            logger.warn(
              `Could not inspect organization membership for ${options.username}: ${errorMessage(error)}`,
            );
          }
        }

        if (organizationMember) {
          try {
            const organizationResponse = await executeApiOperation(
              () => octokit.request('GET /orgs/{org}', { org: organization }),
              retryConfig,
              retryDisabled,
              logger,
              `Fetching organization ${organization}`,
            );
            organizationBasePermission =
              organizationResponse.data.default_repository_permission ?? 'none';
          } catch (error: unknown) {
            organizationAttributionAvailable = false;
            logger.warn(
              `Could not inspect organization base permission: ${errorMessage(error)}`,
            );
          }
        }

        for (const repository of repositories) {
          try {
            const repositoryDetails = await executeApiOperation(
              () =>
                octokit.request('GET /repos/{owner}/{repo}', {
                  owner: organization,
                  repo: repository,
                }),
              retryConfig,
              retryDisabled,
              logger,
              `Fetching ${organization}/${repository}`,
            );
            const permissionResponse = await executeApiOperation(
              () =>
                octokit.request(
                  'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
                  {
                    owner: organization,
                    repo: repository,
                    username: options.username,
                  },
                ),
              retryConfig,
              retryDisabled,
              logger,
              `Fetching effective permission for ${options.username} on ${repository}`,
            );
            const effectivePermission = permissionResponse.data.permission;
            const role =
              permissionResponse.data.user?.role_name ?? effectivePermission;
            const hasAccess = effectivePermission !== 'none';
            const routes: string[] = [];
            let attributionComplete = organizationAttributionAvailable;

            if (!repositoryDetails.data.private && hasAccess) {
              routes.push('public repository');
            }
            if (
              organizationMember &&
              organizationBasePermission !== 'none' &&
              hasAccess
            ) {
              routes.push(
                `organization base permission (${organizationBasePermission})`,
              );
            }

            if (!hasAccess) {
              results.push({
                organization,
                repository,
                username: options.username,
                status: 'success',
                hasAccess: 'no',
                effectivePermission: 'none',
                role: 'none',
                routes: ['none'],
                attributionComplete: true,
                error: '',
              });
              continue;
            }

            try {
              let page = 1;
              let foundDirectGrant = false;
              while (!foundDirectGrant) {
                const collaborators = await executeApiOperation(
                  () =>
                    octokit.request('GET /repos/{owner}/{repo}/collaborators', {
                      owner: organization,
                      repo: repository,
                      affiliation: 'direct',
                      per_page: 100,
                      page,
                    }),
                  retryConfig,
                  retryDisabled,
                  logger,
                  `Fetching direct collaborators for ${repository}, page ${page}`,
                );
                const collaborator = collaborators.data.find(
                  (candidate) =>
                    candidate.login.toLowerCase() ===
                    options.username.toLowerCase(),
                );
                if (collaborator) {
                  const directRole = collaborator.role_name ?? 'unknown';
                  routes.push(
                    `${organizationMember ? 'direct collaborator' : 'outside collaborator'} (${directRole})`,
                  );
                  foundDirectGrant = true;
                }
                if (collaborators.data.length < 100) {
                  break;
                }
                page++;
              }
            } catch (error: unknown) {
              attributionComplete = false;
              logger.warn(
                `Could not inspect direct access for ${repository}: ${errorMessage(error)}`,
              );
            }

            try {
              let page = 1;
              while (true) {
                const teams = await executeApiOperation(
                  () =>
                    octokit.request('GET /repos/{owner}/{repo}/teams', {
                      owner: organization,
                      repo: repository,
                      per_page: 100,
                      page,
                    }),
                  retryConfig,
                  retryDisabled,
                  logger,
                  `Fetching teams for ${repository}, page ${page}`,
                );
                for (const team of teams.data) {
                  try {
                    const membership = await executeApiOperation(
                      () =>
                        octokit.request(
                          'GET /orgs/{org}/teams/{team_slug}/memberships/{username}',
                          {
                            org: organization,
                            team_slug: team.slug,
                            username: options.username,
                          },
                        ),
                      retryConfig,
                      retryDisabled,
                      logger,
                      `Checking ${options.username} membership in ${team.slug}`,
                    );
                    if (membership.data.state === 'active') {
                      routes.push(`team:${team.slug} (${team.permission})`);
                    }
                  } catch (error: unknown) {
                    if (errorStatus(error) !== 404) {
                      attributionComplete = false;
                      logger.warn(
                        `Could not inspect membership in ${team.slug}: ${errorMessage(error)}`,
                      );
                    }
                  }
                }
                if (teams.data.length < 100) {
                  break;
                }
                page++;
              }
            } catch (error: unknown) {
              attributionComplete = false;
              logger.warn(
                `Could not inspect team access for ${repository}: ${errorMessage(error)}`,
              );
            }

            results.push({
              organization,
              repository,
              username: options.username,
              status: 'success',
              hasAccess: hasAccess ? 'yes' : 'no',
              effectivePermission: hasAccess ? effectivePermission : 'none',
              role: hasAccess ? role : 'none',
              routes: hasAccess
                ? uniqueCaseInsensitive(
                    routes.length > 0 ? routes : ['unknown'],
                  )
                : ['none'],
              attributionComplete,
              error: '',
            });
          } catch (error: unknown) {
            results.push({
              organization,
              repository,
              username: options.username,
              status: 'error',
              hasAccess: 'unknown',
              effectivePermission: 'unknown',
              role: 'unknown',
              routes: ['unknown'],
              attributionComplete: false,
              error: errorMessage(error),
            });
            logger.warn(
              `Could not inspect ${organization}/${repository}: ${errorMessage(error)}`,
            );
          }
        }
      },
    );

    const output =
      options.outputFormat === 'markdown'
        ? renderAccessMarkdown(results)
        : renderAccessCsv(results);
    fs.writeFileSync(outputFile, output, 'utf8');
  });

export default getUserRepoAccessCommand;

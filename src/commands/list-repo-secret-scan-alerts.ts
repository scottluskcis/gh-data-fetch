import {
  createCommandWithSharedOptions,
  parseRepoListOption,
} from '../commands/command-helpers.js';
import {
  listAlertsForRepos,
  listAlertsForOrg,
} from '../api/secret-scanning/secret-scanning-alerts.js';
import { executeWithOctokit } from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  initializeCsvFile,
  appendRecordToCsv,
  extractHeaders,
} from '../utils/csv.js';
import { ensureDirectory, generateTimestampedFilename } from '../utils/file.js';

const listAlertsForReposCommand = createCommandWithSharedOptions(
  'list-repo-secret-scan-alerts',
)
  .description(
    'List secret scanning alerts for specified repositories or organization',
  )
  .addOption(
    new Option(
      '--scan-type <type>',
      'Type of scan: "repo" for repositories or "org" for organization',
    )
      .env('SCAN_TYPE')
      .choices(['repo', 'org'])
      .default('repo'),
  )
  .addOption(
    new Option(
      '--repos <repos...>',
      'Comma separated list of repositories in the format owner/repo (for repo scan type)',
    )
      .env('REPOS')
      .argParser(parseRepoListOption),
  )
  .addOption(
    new Option(
      '--state <state>',
      'State of the secret scanning alerts (open, resolved)',
    ).env('STATE'),
  )
  .addOption(
    new Option('--secret-type <type>', 'Type of secret to filter by').env(
      'SECRET_TYPE',
    ),
  )
  .addOption(
    new Option(
      '--resolution <resolution>',
      'Resolution status of the alert',
    ).env('RESOLUTION'),
  )
  .addOption(
    new Option(
      '--validity <validity>',
      'Validity of the secret (active, inactive, unknown)',
    ).env('VALIDITY'),
  )
  .addOption(
    new Option(
      '--is-publicly-leaked',
      'Filter for publicly leaked secrets',
    ).env('IS_PUBLICLY_LEAKED'),
  )
  .addOption(
    new Option(
      '--is-multi-repo',
      'Filter for secrets found in multiple repositories',
    ).env('IS_MULTI_REPO'),
  )
  .addOption(
    new Option('--hide-secret', 'Hide the actual secret value in output')
      .env('HIDE_SECRET')
      .default(true),
  )
  .action(async (options) => handleAction(options));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(options: any) {
  const scanType = options.scanType || 'repo';
  let repoList = options.repos;

  // If no repos option is provided but repoList (file path) exists, read repos from file
  // Only applicable for 'repo' scan type
  if (scanType === 'repo' && !repoList && options.repoList) {
    const fileContent = fs.readFileSync(options.repoList, 'utf8');
    const lines = fileContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Parse each line as owner/repo format
    repoList = lines.map((line) => {
      const [owner, repo] = line.split('/');
      return { owner, repo };
    });
  }

  const opts = {
    scanType,
    org: options.orgName,
    owner: options.orgName,
    repo: undefined,
    repos: repoList,
    state: options.state,
    secret_type: options.secretType,
    resolution: options.resolution,
    validity: options.validity,
    page: options.page,
    per_page: options.pageSize,
    is_publicly_leaked: options.isPubliclyLeaked,
    is_multi_repo: options.isMultiRepo,
    hide_secret: options.hideSecret,
    outputFileName: options.outputFileName,
  };
  return opts;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAction(options: any) {
  await executeWithOctokit(options, async ({ octokit, logger }) => {
    const opts = {
      octokit,
      ...parseArgs(options),
    };

    const scanType = opts.scanType;

    // Validate inputs based on scan type
    if (scanType === 'repo' && (!opts.repos || opts.repos.length === 0)) {
      logger.error(
        'Error: --repos option or --repo-list file is required for repo scan type',
      );
      process.exit(1);
    }

    if (scanType === 'org' && !opts.org) {
      logger.error('Error: --org-name option is required for org scan type');
      process.exit(1);
    }

    logger.info(
      `Starting to list secret scanning alerts (${scanType} mode)...`,
    );

    // Set up output directory and file path
    const outputDir = path.join(process.cwd(), 'output');
    ensureDirectory(outputDir);

    // Use provided output filename or generate a default timestamped one with scan type
    const filename =
      opts.outputFileName ||
      generateTimestampedFilename(`secret-scanning-alerts-${scanType}`, 'csv');
    const csvFilePath = path.join(outputDir, filename);

    let headers: string[] = [];
    let isFirstAlert = true;

    // Choose the appropriate function based on scan type
    const alertIterator =
      scanType === 'org'
        ? listAlertsForOrg({ ...opts })
        : listAlertsForRepos({ ...opts });

    for await (const alert of alertIterator) {
      // On first alert, extract headers and initialize CSV file
      if (isFirstAlert) {
        // Add scanType to the alert object for CSV output
        const alertWithType = { scanType, ...alert };
        headers = extractHeaders(alertWithType);
        initializeCsvFile(csvFilePath, headers);
        isFirstAlert = false;
        logger.info(`Initialized CSV file: ${csvFilePath}`);
      }

      // Append alert to CSV file with scanType included
      const alertWithType = { scanType, ...alert };
      appendRecordToCsv(csvFilePath, alertWithType, headers);
    }

    if (isFirstAlert) {
      logger.info('No alerts found.');
    } else {
      logger.info(`Secret scanning alerts written to: ${csvFilePath}`);
    }
  });
}

export default listAlertsForReposCommand;

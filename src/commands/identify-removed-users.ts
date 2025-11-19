import {
  createCommandWithSharedOptions,
  parseRepoListOption,
} from './command-helpers.js';
import { getAuditLogActivity } from '../api/audit-log-events.js';
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
import { c } from 'tar';

const identifyRemovedUsersCommand = createCommandWithSharedOptions(
  'identify-removed-users',
)
  .description('List audit log events for the specified organization')
  .addOption(
    new Option(
      '--created-start <date>',
      'Start date (ISO format) to filter audit log events from',
    ).env('CREATED_START'),
  )
  .addOption(
    new Option(
      '--created-end <date>',
      'End date (ISO format) to filter audit log events to',
    ).env('CREATED_END'),
  )
  .action(async (options) => handleAction(options));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseArgs(options: any) {
  let repoList = options.repos;

  // If no repos option is provided but repoList (file path) exists, read repos from file
  if (!repoList && options.repoList) {
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

  // Build created array only if dates are provided
  const created = [];
  if (options.createdStart) {
    created.push(`>=${options.createdStart}`);
  }
  if (options.createdEnd) {
    created.push(`<${options.createdEnd}`);
  }

  return {
    org: options.orgName,
    owner: options.orgName,
    enterprise: options.enterpriseName,
    repo: undefined,
    repos: repoList,
    createdStart: options.createdStart,
    createdEnd: options.createdEnd,
    created: created.length > 0 ? created : undefined,
    outputFileName: options.outputFileName,
  };
}

async function getAdd() {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAction(options: any) {
  await executeWithOctokit(options, async ({ octokit, logger }) => {
    const opts = {
      octokit,
      ...parseArgs(options),
    };
    logger.info('Fetching audit log events...');

    // username: repo: permission
    const memberLookup = new Map<
      string,
      Record<
        string,
        {
          permission: string;
          created_at: string;
          actor: string;
          document_id: string;
          request_id: string;
          repo: string;
        }
      >
    >();

    // get the add member events for comparison
    const addMemberIterator = getAuditLogActivity({
      octokit: octokit,
      orgName: opts.org,
      enterpriseName: opts.enterprise,
      action: 'repo.add_member',
      type: 'enterprise',
      created: `<${opts.createdStart}`, // anything before the removal date
    });
    for await (const event of addMemberIterator) {
      const user = event.props.user;
      const repo = event.props.repo;

      if (!memberLookup.has(user)) {
        memberLookup.set(user, {});
      }

      const repoPermissions = memberLookup.get(user)!;
      repoPermissions[repo] = {
        permission: event.props.permission,
        created_at: event.props.created_at,
        actor: event.actor,
        document_id: event.props._document_id,
        request_id: event.props.request_id,
        repo: repo,
      };
      memberLookup.set(user, repoPermissions);

      logger.info(
        `Added member event processed: ${user} in ${repo}. Count: ${
          memberLookup.size
        }`,
      );
    }

    logger.info(memberLookup.size + ' members found added.');

    // Set up output directory and file path
    const outputDir = path.join(process.cwd(), 'output');
    ensureDirectory(outputDir);

    // Use provided output filename or generate a default timestamped one with scan type
    const baseFilename = `removed-users-${opts.org}`;
    const filename = generateTimestampedFilename(baseFilename, 'csv');
    const csvFilePath = path.join(outputDir, filename);

    let headers: string[] = [
      'actor',
      'user',
      'repo',
      'removed_at',
      'action',
      'operation_type',
      'org',
      'visibility',
      'timestamp',
      'created_at',
      'document_id',
      'request_id',
      'orig_permission',
      'orig_created_at',
      'orig_actor',
      'orig_document_id',
      'orig_request_id',
    ];

    initializeCsvFile(csvFilePath, headers);

    // get the remove events for date
    const removeMemberIterator = getAuditLogActivity({
      octokit: octokit,
      orgName: opts.org,
      enterpriseName: opts.enterprise,
      action: 'repo.remove_member',
      created: opts.created,
      type: 'enterprise',
    });

    let processedCount = 0;
    logger.info('Processing removed member events...');

    for await (const event of removeMemberIterator) {
      logger.info(JSON.stringify(event));

      const existing = memberLookup.get(event.props.user);
      const existingInfo = existing ? existing[event.props.repo] : undefined;

      const info = {
        actor: event.actor,
        user: event.props.user,
        repo: event.props.repo,
        removed_at: event.date,
        action: event.action,
        operation_type: event.props.operation_type,
        org: event.props.org,
        visibility: event.props.visibility,
        timestamp: event.props['@timestamp'],
        created_at: event.props.created_at,
        document_id: event.props._document_id,
        request_id: event.props.request_id,
        orig_permission: existingInfo?.permission,
        orig_created_at: existingInfo?.created_at,
        orig_actor: existingInfo?.actor,
        orig_document_id: existingInfo?.document_id,
        orig_request_id: existingInfo?.request_id,
      };

      appendRecordToCsv(csvFilePath, info, headers);

      processedCount++;
      logger.info(
        `Removed member event processed: ${event.props.user} from ${event.props.repo}. Processed count: ${processedCount}`,
      );
    }

    logger.info(`Audit log events written to CSV file: ${csvFilePath}`);
  });
}

export default identifyRemovedUsersCommand;

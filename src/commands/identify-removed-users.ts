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
  .addOption(
    new Option(
      '--actor-filter <actors>',
      'Comma-separated list of actors whose removals should be considered for restoration',
    ).env('ACTOR_FILTER'),
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

  // Parse actor filter
  let actorFilter: string[] | undefined = undefined;
  if (options.actorFilter) {
    actorFilter = options.actorFilter
      .split(',')
      .map((actor: string) => actor.trim())
      .filter((actor: string) => actor.length > 0);
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
    actorFilter: actorFilter,
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

    // Track all removal events by user:repo for subsequent activity detection
    const removalEvents = new Map<
      string,
      Array<{
        actor: string;
        timestamp: number;
        removed_at: string;
        created_at: string;
      }>
    >();

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
      'should_restore',
      'subsequent_activity',
      'subsequent_activity_actor',
      'subsequent_activity_timestamp',
    ];

    initializeCsvFile(csvFilePath, headers);

    // First pass: collect all removal events
    const allRemovalEvents: Array<{
      event: any;
      existing: any;
      existingInfo: any;
    }> = [];

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

      const user = event.props.user;
      const repo = event.props.repo;
      const userRepoKey = `${user}:${repo}`;

      // Track this removal event
      if (!removalEvents.has(userRepoKey)) {
        removalEvents.set(userRepoKey, []);
      }
      removalEvents.get(userRepoKey)!.push({
        actor: event.actor,
        timestamp: event.props.created_at,
        removed_at: String(event.date),
        created_at: event.props.created_at,
      });

      const existing = memberLookup.get(user);
      const existingInfo = existing ? existing[repo] : undefined;

      allRemovalEvents.push({
        event,
        existing,
        existingInfo,
      });

      processedCount++;
      logger.info(
        `Removed member event processed: ${user} from ${repo}. Processed count: ${processedCount}`,
      );
    }

    logger.info(`Total removal events collected: ${allRemovalEvents.length}`);

    // Second pass: determine should_restore for each removal
    logger.info('Analyzing subsequent activity...');
    let restorationCandidates = 0;
    let skippedDueToSubsequentActivity = 0;

    for (const { event, existing, existingInfo } of allRemovalEvents) {
      const user = event.props.user;
      const repo = event.props.repo;
      const actor = event.actor;
      const removalTimestamp = event.props.created_at;
      const userRepoKey = `${user}:${repo}`;

      // Check if actor matches filter (if filter is provided)
      const actorMatches =
        !opts.actorFilter || opts.actorFilter.includes(actor);

      let shouldRestore = false;
      let subsequentActivity = '';
      let subsequentActivityActor = '';
      let subsequentActivityTimestamp = '';

      if (actorMatches) {
        // Check for subsequent removals
        const removals = removalEvents.get(userRepoKey) || [];
        const laterRemovals = removals.filter(
          (r) => r.timestamp > removalTimestamp,
        );

        if (laterRemovals.length > 0) {
          const laterRemoval = laterRemovals[0];
          subsequentActivity = `Removed again after this event`;
          subsequentActivityActor = laterRemoval.actor;
          subsequentActivityTimestamp = laterRemoval.removed_at;
        } else {
          // Check if user was re-added after this removal
          if (
            existingInfo &&
            existingInfo.created_at &&
            existingInfo.created_at > removalTimestamp
          ) {
            subsequentActivity = `Re-added after this removal`;
            subsequentActivityActor = existingInfo.actor;
            subsequentActivityTimestamp = existingInfo.created_at;
          } else {
            // No subsequent activity found - safe to restore
            shouldRestore = true;
            restorationCandidates++;
          }
        }

        if (!shouldRestore) {
          skippedDueToSubsequentActivity++;
        }
      } else {
        // Actor doesn't match filter
        subsequentActivity = `Actor '${actor}' not in filter list`;
      }

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
        should_restore: shouldRestore,
        subsequent_activity: subsequentActivity,
        subsequent_activity_actor: subsequentActivityActor,
        subsequent_activity_timestamp: subsequentActivityTimestamp,
      };

      appendRecordToCsv(csvFilePath, info, headers);
    }

    logger.info(`\n=== Summary ===`);
    logger.info(`Total removal events: ${allRemovalEvents.length}`);
    logger.info(
      `Restoration candidates (should_restore=true): ${restorationCandidates}`,
    );
    logger.info(
      `Skipped due to subsequent activity: ${skippedDueToSubsequentActivity}`,
    );
    logger.info(`Audit log events written to CSV file: ${csvFilePath}`);
  });
}

export default identifyRemovedUsersCommand;

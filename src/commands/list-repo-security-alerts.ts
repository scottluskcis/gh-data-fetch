import {
  createBaseCommand,
  executeWithOctokit,
} from '@scottluskcis/octokit-harness';

const listRepoSecurityAlertsCommand = createBaseCommand({
  name: 'list-repo-security-alerts',
  description: 'List security alerts for repositories in an organization',
}).action(async (options) => {
  await executeWithOctokit(options, async ({ octokit, logger, opts }) => {
    logger.info('Starting...');

    // do your work here using octokit
    // ....

    logger.info('Finished');
  });
});

export default listRepoSecurityAlertsCommand;

import {
  createBaseCommand,
  executeWithOctokit,
} from '@scottluskcis/octokit-harness';

const listReposWithPagesCommand = createBaseCommand({
  name: 'list-repos-with-pages',
  description: 'List any repos that use GitHub Pages',
}).action(async (options) => {
  await executeWithOctokit(options, async ({ octokit, logger, opts }) => {
    logger.info('Starting...');

    // do your work here using octokit
    // ....

    logger.info('Finished');
  });
});

export default listReposWithPagesCommand;

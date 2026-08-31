import {
  type Arguments,
  executeWithOctokit,
} from '@scottluskcis/octokit-harness';
import { Option } from 'commander';
import fs from 'fs';
import { ensureOutputPathWritable } from '../utils/csv.js';
import {
  createCommandWithSharedOptions,
  parseBooleanOption,
  parseIntOption,
} from './command-helpers.js';

const OUTPUT_TYPES = ['json', 'human', 'both'] as const;

type OutputType = (typeof OUTPUT_TYPES)[number];

interface GetIssueByIdOptions extends Arguments {
  repository: string;
  issueId: number;
  outputType: OutputType;
  outputFile?: string;
  force: boolean;
}

interface IssueUser {
  login: string;
}

interface IssueLabel {
  name?: string;
}

interface IssueMilestone {
  title: string;
}

interface IssueAssignee {
  login: string;
}

interface IssueDetails {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: IssueUser | null;
  assignees?: IssueAssignee[] | null;
  labels: (string | IssueLabel)[];
  milestone: IssueMilestone | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body?: string | null;
  pull_request?: unknown;
}

export function parseRepository(repository: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...extra] = repository.split('/');
  if (!owner || !repo || extra.length > 0) {
    throw new Error('Repository must be in owner/repository format');
  }
  return { owner, repo };
}

export function parseIssueId(value: string): number {
  const issueId = parseIntOption(value);
  if (issueId <= 0) {
    throw new Error(`Issue ID must be a positive integer: ${value}`);
  }
  return issueId;
}

export function formatIssueHuman(issue: IssueDetails): string {
  const labels = issue.labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((label): label is string => Boolean(label))
    .join(', ');
  const assignees =
    issue.assignees?.map((assignee) => assignee.login).join(', ') ?? '';

  return [
    `#${issue.number}: ${issue.title}`,
    `State: ${issue.state}`,
    `URL: ${issue.html_url}`,
    `Author: ${issue.user?.login ?? 'unknown'}`,
    `Assignees: ${assignees || 'none'}`,
    `Labels: ${labels || 'none'}`,
    `Milestone: ${issue.milestone?.title ?? 'none'}`,
    `Created: ${issue.created_at}`,
    `Updated: ${issue.updated_at}`,
    `Closed: ${issue.closed_at ?? 'none'}`,
    `Type: ${issue.pull_request ? 'pull request' : 'issue'}`
    '',
    issue.body ?? '',
  ].join('\n');
}

export function formatIssueOutput(
  issue: IssueDetails,
  outputType: OutputType,
): string {
  if (outputType === 'json') {
    return JSON.stringify(issue, null, 2);
  }
  if (outputType === 'human') {
    return formatIssueHuman(issue);
  }
  return `${formatIssueHuman(issue)}\n\n${JSON.stringify(issue, null, 2)}`;
}

function writeOutput(output: string, outputFile: string | undefined): void {
  if (outputFile) {
    fs.writeFileSync(outputFile, `${output}\n`, 'utf8');
    return;
  }
  process.stdout.write(`${output}\n`);
}

const getIssueByIdCommand = createCommandWithSharedOptions('get-issue-by-id')
  .description('Get one GitHub issue by issue number from a repository')
  .addOption(
    new Option(
      '--repository <owner/repo>',
      'Repository containing the issue, in owner/repo format',
    )
      .env('REPOSITORY')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--issue-id <id>', 'Issue number from the repository issue URL')
      .env('ISSUE_ID')
      .argParser(parseIssueId)
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('--output-type <type>', 'Output type: json, human, or both')
      .env('OUTPUT_TYPE')
      .choices(OUTPUT_TYPES)
      .default('json'),
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
Requires authentication that can read the requested repository. By default, the
issue is written to stdout as JSON. Use --output-type human or --output-type both
to include a readable summary, and --output-file to write the selected output to
a file instead of stdout.
`,
  )
  .action(async (options: GetIssueByIdOptions) => {
    const { owner, repo } = parseRepository(options.repository);
    const outputFile = options.outputFile
      ? ensureOutputPathWritable(options.outputFile, options.force)
      : undefined;

    const issue = await executeWithOctokit(
      options,
      async ({ octokit, logger }) => {
        const response = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: options.issueId,
        });
        logger.info(
          `Fetched issue #${response.data.number} from ${owner}/${repo}`,
        );
        return response.data;
      },
    );
    writeOutput(formatIssueOutput(issue, options.outputType), outputFile);
  });

export default getIssueByIdCommand;

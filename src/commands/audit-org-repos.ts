import { Command, Option } from 'commander';
import fs from 'fs';
import path from 'path';
import {
  buildAuditRecords,
  collectTargetRepoList,
  deriveMarkdownPath,
  parseAuditSourceExport,
  parseAuditTargetExport,
  renderAuditCsv,
  renderAuditMarkdown,
  summarizeAuditRecords,
  type AuditTargetRepo,
  type TargetRepoListEntry,
  type TargetRole,
} from '../utils/audit-repos.js';
import { ensureOutputPathWritable } from '../utils/csv.js';
import { parseBooleanOption } from './command-helpers.js';

/**
 * `audit-org-repos` is a pure local file-diff/report command: it never talks
 * to the GitHub API, so unlike most other commands it does not build on
 * `createCommandWithSharedOptions` (which adds auth, pagination, retry, and
 * other API-oriented options that would not apply here).
 */
const auditOrgReposCommand = new Command('audit-org-repos')
  .description(
    'Audit a source organization repository export against software/archive migration target exports (all produced by list-org-repos), and write a combined CSV plus a human-readable Markdown report',
  )
  .addOption(
    new Option(
      '--repo-list <file>',
      'Path to the source organization list-org-repos CSV export',
    )
      .env('REPO_LIST')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--target-repo-list <role=path>',
      'Target organization list-org-repos CSV export, tagged with a role (software or archive); repeat for each role',
    )
      .env('TARGET_REPO_LIST')
      .argParser(collectTargetRepoList)
      .default([] as TargetRepoListEntry[]),
  )
  .addOption(
    new Option(
      '--archive-suffix <suffix>',
      'Suffix appended to repository names in the archive target export (e.g. -dova); required when an archive target is provided',
    ).env('ARCHIVE_SUFFIX'),
  )
  .addOption(
    new Option(
      '--migration-issue-url-prefix <url>',
      'URL prefix used to render migration_issue as a clickable link in the Markdown report (e.g. https://github.com/org/repo/issues/)',
    ).env('MIGRATION_ISSUE_URL_PREFIX'),
  )
  .addOption(
    new Option(
      '--output-file <file>',
      'Path to write the combined audit CSV; the Markdown report is written alongside it with a .md extension',
    )
      .env('OUTPUT_FILE')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option(
      '--force [boolean]',
      'Allow writing to existing output CSV/Markdown paths',
    )
      .env('FORCE')
      .argParser(parseBooleanOption)
      .default(false),
  )
  .addHelpText(
    'after',
    `
Requires --repo-list (source export) and at least one --target-repo-list
role=path (software and/or archive), plus --output-file. Nothing is written
until every input and output path has been validated. --archive-suffix is
required whenever an archive target is supplied.
`,
  )
  .action(async (options) => {
    const targetEntries = options.targetRepoList as TargetRepoListEntry[];
    if (targetEntries.length === 0) {
      throw new Error(
        'At least one --target-repo-list role=path is required (role: software or archive)',
      );
    }

    const repoListPath = path.resolve(options.repoList);
    for (const entry of targetEntries) {
      if (path.resolve(entry.path) === repoListPath) {
        throw new Error(
          `--target-repo-list "${entry.role}=${entry.path}" resolves to the same file as --repo-list; a target export cannot be the source export`,
        );
      }
      if (entry.role === 'archive' && !options.archiveSuffix) {
        throw new Error(
          '--archive-suffix is required when an archive target is provided',
        );
      }
    }
    if (
      options.archiveSuffix &&
      !targetEntries.some((entry) => entry.role === 'archive')
    ) {
      throw new Error(
        '--archive-suffix was provided but no archive target was specified via --target-repo-list',
      );
    }

    // Validate output paths before parsing/writing anything.
    const csvPath = ensureOutputPathWritable(options.outputFile, options.force);
    const markdownPath = ensureOutputPathWritable(
      deriveMarkdownPath(csvPath),
      options.force,
    );

    const source = parseAuditSourceExport(
      fs.readFileSync(repoListPath, 'utf8'),
      `--repo-list (${repoListPath})`,
    );

    const targetsByRole: Partial<Record<TargetRole, AuditTargetRepo[]>> = {};
    const fileLabelsByRole: Partial<Record<TargetRole, string>> = {};
    for (const entry of targetEntries) {
      const resolvedPath = path.resolve(entry.path);
      const fileLabel = `--target-repo-list ${entry.role} (${resolvedPath})`;
      const target = parseAuditTargetExport(
        fs.readFileSync(resolvedPath, 'utf8'),
        fileLabel,
      );
      if (target.organization.toLowerCase() === source.organization.toLowerCase()) {
        throw new Error(
          `${fileLabel} has the same organization ("${target.organization}") as the source export; a target cannot be the source organization`,
        );
      }
      targetsByRole[entry.role] = target.repositories;
      fileLabelsByRole[entry.role] = fileLabel;
    }

    const records = buildAuditRecords(source.repositories, targetsByRole, {
      archiveSuffix: options.archiveSuffix,
      softwareFileLabel: fileLabelsByRole.software,
      archiveFileLabel: fileLabelsByRole.archive,
      onWarning: (message) => console.warn(`Warning: ${message}`),
    });
    const summary = summarizeAuditRecords(records);

    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(csvPath, renderAuditCsv(records), 'utf8');
    fs.writeFileSync(
      markdownPath,
      renderAuditMarkdown(records, summary, {
        title: `${source.organization} Repository Migration Audit`,
        migrationIssueUrlPrefix: options.migrationIssueUrlPrefix,
      }),
      'utf8',
    );

    console.log(
      `Audited ${records.length} repositories from ${source.organization}; wrote ${csvPath} and ${markdownPath}`,
    );
  });

export default auditOrgReposCommand;

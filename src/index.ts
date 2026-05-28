import 'varlock/auto-load';
import { createProgram } from '@scottluskcis/octokit-harness';

import getRepoReleaseSizesCommand from './commands/get-repo-release-sizes.js';
import getPackageDetailsCommand from './commands/get-package-details.js';
import getAssigneeIssues from './commands/get-issues-by-user.js';
import listOrgMigrationsCommand from './commands/list-org-migrations.js';
import unlockOrgRepositoryCommand from './commands/unlock-org-repository.js';
import listWebhooksCommand from './commands/list-webhooks.js';
import listTeamMembersCommand from './commands/list-team-members.js';
import codespacesUsageCommand from './commands/codespaces-usage.js';
import getMigrationExportStatusCommand from './commands/migration-export-status.js';
import listRepoSecretScanAlertsCommand from './commands/list-repo-secret-scan-alerts.js';
import identifyRemovedUsersCommand from './commands/identify-removed-users.js';
import restoreRemovedUsersCommand from './commands/restore-removed-users.js';

const program = createProgram({
  name: 'octokit-sandbox',
  description: 'A tool for interacting with GitHub repositories',
  commands: [
    getPackageDetailsCommand,
    getRepoReleaseSizesCommand,
    getAssigneeIssues,
    listOrgMigrationsCommand,
    unlockOrgRepositoryCommand,
    listWebhooksCommand,
    listTeamMembersCommand,
    codespacesUsageCommand,
    getMigrationExportStatusCommand,
    listRepoSecretScanAlertsCommand,
    identifyRemovedUsersCommand,
    restoreRemovedUsersCommand,
  ],
});

program.parse(process.argv);

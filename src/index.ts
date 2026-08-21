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
import listReposWithPagesCommand from './commands/list-repos-with-pages.js';
import compareOrgRepositoriesCommand from './commands/compare-org-repositories.js';
import setOrgRepoCustomPropertyCommand from './commands/set-org-repo-custom-property.js';
import auditOrgReposCommand from './commands/audit-org-repos.js';
import listEnterpriseOrgsCommand from './commands/list-enterprise-orgs.js';
import listOrgReposCommand from './commands/list-org-repos.js';

const program = createProgram({
  name: 'octokit-sandbox',
  description: 'A tool for interacting with GitHub repositories',
  commands: [
    auditOrgReposCommand,
    getPackageDetailsCommand,
    getRepoReleaseSizesCommand,
    getAssigneeIssues,
    listOrgMigrationsCommand,
    listEnterpriseOrgsCommand,
    listOrgReposCommand,
    unlockOrgRepositoryCommand,
    listWebhooksCommand,
    listTeamMembersCommand,
    codespacesUsageCommand,
    getMigrationExportStatusCommand,
    listRepoSecretScanAlertsCommand,
    listReposWithPagesCommand,
    compareOrgRepositoriesCommand,
    setOrgRepoCustomPropertyCommand,
  ],
});

program.parse(process.argv);

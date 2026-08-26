import fs from 'fs';
import { parseCsvRecords } from './csv.js';

export interface RepositoryReference {
  organization: string;
  repository: string;
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

function nonemptyLines(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function appearsToBeCsv(
  contents: string,
  singleColumnHeader?: string,
): boolean {
  const firstLine = nonemptyLines(contents)[0] ?? '';
  return (
    firstLine.includes(',') ||
    firstLine.toLowerCase() === singleColumnHeader?.toLowerCase()
  );
}

export function parseOrganizationFile(contents: string): string[] {
  let organizations: string[];
  if (appearsToBeCsv(contents, 'organization_login')) {
    const records = parseCsvRecords(contents);
    if (
      records.length === 0 ||
      !Object.prototype.hasOwnProperty.call(records[0], 'organization_login')
    ) {
      throw new Error(
        'Organization CSV must contain an organization_login header',
      );
    }
    organizations = records.map((record) => record.organization_login?.trim());
  } else {
    organizations = nonemptyLines(contents);
  }

  const valid = organizations.filter(Boolean);
  if (valid.length === 0) {
    throw new Error('Organization file does not contain any organizations');
  }
  return uniqueCaseInsensitive(valid);
}

export function resolveOrganizations(
  repeatedOrganizations: string[],
  organizationFile?: string,
  sharedOrganizationName?: string,
): string[] {
  const organizations = repeatedOrganizations
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  if (sharedOrganizationName) {
    organizations.push(
      ...sharedOrganizationName
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }
  if (organizationFile) {
    organizations.push(
      ...parseOrganizationFile(fs.readFileSync(organizationFile, 'utf8')),
    );
  }

  const resolved = uniqueCaseInsensitive(organizations);
  if (resolved.length === 0) {
    throw new Error(
      'Specify at least one organization with --org, --org-file, or --org-name',
    );
  }
  return resolved;
}

export function parseRepositoryFile(contents: string): RepositoryReference[] {
  let repositories: RepositoryReference[];
  if (appearsToBeCsv(contents)) {
    const records = parseCsvRecords(contents);
    if (
      records.length === 0 ||
      !Object.prototype.hasOwnProperty.call(records[0], 'organization_login') ||
      !Object.prototype.hasOwnProperty.call(records[0], 'repository_name')
    ) {
      throw new Error(
        'Repository CSV must contain organization_login and repository_name headers',
      );
    }
    repositories = records.map((record) => ({
      organization: record.organization_login?.trim(),
      repository: record.repository_name?.trim(),
    }));
  } else {
    repositories = nonemptyLines(contents).map((line, index) => {
      const segments = line.split('/');
      if (segments.length !== 2 || !segments[0] || !segments[1]) {
        throw new Error(
          `Invalid repository at line ${index + 1}: expected owner/repository`,
        );
      }
      return {
        organization: segments[0].trim(),
        repository: segments[1].trim(),
      };
    });
  }

  if (
    repositories.length === 0 ||
    repositories.some(
      ({ organization, repository }) => !organization || !repository,
    )
  ) {
    throw new Error('Repository file contains an empty or missing repository');
  }

  const seen = new Set<string>();
  return repositories.filter(({ organization, repository }) => {
    const key = `${organization}/${repository}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

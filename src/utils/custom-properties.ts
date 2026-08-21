export const CUSTOM_PROPERTY_BATCH_SIZE = 30;

export function resolveCustomPropertyValue(
  propertyValue: unknown,
  clearPropertyValue: unknown,
): string | null {
  const shouldClear =
    clearPropertyValue === true || clearPropertyValue === 'true';

  if (shouldClear) {
    if (typeof propertyValue === 'string') {
      throw new Error('Specify exactly one of --property-value or --clear');
    }
    return null;
  }

  if (typeof propertyValue !== 'string') {
    throw new Error('Specify exactly one of --property-value or --clear');
  }

  return propertyValue;
}

export function parseRepositoryList(
  fileContents: string,
  organization: string,
): string[] {
  const repositories: string[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of fileContents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const segments = line.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      throw new Error(
        `Invalid repository at line ${index + 1}: expected owner/repository`,
      );
    }

    const [owner, repository] = segments;
    if (owner.toLowerCase() !== organization.toLowerCase()) {
      throw new Error(
        `Repository at line ${index + 1} belongs to ${owner}, not ${organization}`,
      );
    }

    const normalizedName = repository.toLowerCase();
    if (!seen.has(normalizedName)) {
      seen.add(normalizedName);
      repositories.push(repository);
    }
  }

  if (repositories.length === 0) {
    throw new Error('The repository list does not contain any repositories');
  }

  return repositories;
}

export function selectRepositoryNames(
  organizationRepositories: string[],
  requestedRepositories?: string[],
): string[] {
  if (!requestedRepositories) {
    return organizationRepositories;
  }

  const namesByLowercase = new Map(
    organizationRepositories.map((name) => [name.toLowerCase(), name]),
  );
  const missingRepositories = requestedRepositories.filter(
    (name) => !namesByLowercase.has(name.toLowerCase()),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `Repositories not found in the organization: ${missingRepositories.join(', ')}`,
    );
  }

  return requestedRepositories.map(
    (name) => namesByLowercase.get(name.toLowerCase())!,
  );
}

export function chunkRepositoryNames(
  repositoryNames: string[],
  batchSize = CUSTOM_PROPERTY_BATCH_SIZE,
): string[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Batch size must be a positive integer');
  }

  const batches: string[][] = [];
  for (let index = 0; index < repositoryNames.length; index += batchSize) {
    batches.push(repositoryNames.slice(index, index + batchSize));
  }
  return batches;
}

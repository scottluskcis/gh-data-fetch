export const CUSTOM_PROPERTY_BATCH_SIZE = 30;

export interface CustomPropertyValue {
  property_name: string;
  value: string | string[] | null;
}

/**
 * Combines repeated CLI values and comma-separated entries into a
 * de-duplicated, ordered list of custom property names.
 */
export function resolvePropertyNames(
  repeatedPropertyNames: string[],
): string[] {
  const names = repeatedPropertyNames
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  return names.filter((name) => {
    if (seen.has(name)) {
      return false;
    }
    seen.add(name);
    return true;
  });
}

/**
 * Filters a repository's custom property values down to the requested
 * names, filling in `null` for names the repository does not have set. When
 * no names are requested, every value on the repository is returned as-is.
 */
export function selectPropertyValues(
  properties: CustomPropertyValue[],
  requestedPropertyNames: string[],
): CustomPropertyValue[] {
  if (requestedPropertyNames.length === 0) {
    return properties;
  }

  const valuesByName = new Map(
    properties.map((property) => [property.property_name, property.value]),
  );
  return requestedPropertyNames.map((name) => ({
    property_name: name,
    value: valuesByName.get(name) ?? null,
  }));
}

/**
 * Renders a custom property value for CSV output, flattening the
 * `multi_select` array shape into a JSON string.
 */
export function customPropertyDisplayValue(
  value: string | string[] | null,
): string | null {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

export function resolveCustomPropertyValue(
  propertyValue: unknown,
  clearPropertyValue: unknown,
): string | null {
  const shouldClear =
    clearPropertyValue === true || clearPropertyValue === 'true';
  const hasPropertyValue =
    typeof propertyValue === 'string' && propertyValue !== '';

  if (shouldClear) {
    if (hasPropertyValue) {
      throw new Error('Specify exactly one of --property-value or --clear');
    }
    return null;
  }

  if (!hasPropertyValue) {
    throw new Error('Specify exactly one of --property-value or --clear');
  }

  return propertyValue as string;
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

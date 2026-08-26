export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }
  return undefined;
}

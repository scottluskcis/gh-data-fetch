import { describe, expect, it } from 'vitest';
import {
  parseOrganizationFile,
  parseRepositoryFile,
} from '../../src/utils/github-input.js';

describe('parseOrganizationFile', () => {
  it('parses and de-duplicates newline-delimited slugs', () => {
    expect(parseOrganizationFile('Acme\nbeta\nacme\n')).toEqual([
      'Acme',
      'beta',
    ]);
  });

  it('parses the single-column enterprise organization CSV format', () => {
    expect(parseOrganizationFile('organization_login\nacme\nbeta\n')).toEqual([
      'acme',
      'beta',
    ]);
  });

  it('requires the organization_login CSV header', () => {
    expect(() => parseOrganizationFile('login,name\nacme,Acme\n')).toThrow(
      'organization_login',
    );
  });
});

describe('parseRepositoryFile', () => {
  it('parses owner/repository lines and de-duplicates case-insensitively', () => {
    expect(parseRepositoryFile('Acme/One\nacme/one\nAcme/Two\n')).toEqual([
      { organization: 'Acme', repository: 'One' },
      { organization: 'Acme', repository: 'Two' },
    ]);
  });

  it('parses list-org-repos CSV records', () => {
    expect(
      parseRepositoryFile(
        'organization_login,repository_name,description\nacme,one,Example\n',
      ),
    ).toEqual([{ organization: 'acme', repository: 'one' }]);
  });

  it('rejects malformed repository inputs', () => {
    expect(() => parseRepositoryFile('one\n')).toThrow('owner/repository');
    expect(() =>
      parseRepositoryFile('organization_login,name\nacme,one\n'),
    ).toThrow('repository_name');
  });
});

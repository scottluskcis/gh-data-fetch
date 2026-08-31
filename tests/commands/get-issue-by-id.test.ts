import { describe, expect, it } from 'vitest';
import {
  formatIssueHuman,
  formatIssueOutput,
  parseIssueId,
  parseRepository,
} from '../../src/commands/get-issue-by-id.js';

const issue = {
  number: 42,
  title: 'Fix the thing',
  state: 'open',
  html_url: 'https://github.com/acme/project/issues/42',
  user: { login: 'octocat' },
  assignees: [{ login: 'hubot' }],
  labels: [{ name: 'bug' }, 'help wanted'],
  milestone: { title: 'v1' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  closed_at: null,
  body: 'Issue body',
};

describe('get-issue-by-id command helpers', () => {
  it('parses owner/repository input', () => {
    expect(parseRepository('acme/project')).toEqual({
      owner: 'acme',
      repo: 'project',
    });
  });

  it('rejects malformed repository input', () => {
    expect(() => parseRepository('acme')).toThrow(
      'Repository must be in owner/repository format',
    );
    expect(() => parseRepository('acme/project/extra')).toThrow(
      'Repository must be in owner/repository format',
    );
  });

  it('parses positive issue IDs', () => {
    expect(parseIssueId('42')).toBe(42);
  });

  it('rejects nonpositive issue IDs', () => {
    expect(() => parseIssueId('0')).toThrow(
      'Issue ID must be a positive integer',
    );
    expect(() => parseIssueId('-1')).toThrow(
      'Issue ID must be a positive integer',
    );
  });

  it('formats human-readable issue output', () => {
    expect(formatIssueHuman(issue)).toContain('#42: Fix the thing');
    expect(formatIssueHuman(issue)).toContain('Assignees: hubot');
    expect(formatIssueHuman(issue)).toContain('Labels: bug, help wanted');
  });

  it('formats JSON and combined output', () => {
    expect(formatIssueOutput(issue, 'json')).toBe(
      JSON.stringify(issue, null, 2),
    );
    expect(formatIssueOutput(issue, 'both')).toContain('#42: Fix the thing');
    expect(formatIssueOutput(issue, 'both')).toContain(
      '"title": "Fix the thing"',
    );
  });
});

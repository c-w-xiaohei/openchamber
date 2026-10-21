import { describe, expect, test } from 'bun:test';

import { resolveBranchOnTopSource, resolveDefaultSourceBranch } from './worktreeSourceBranchPreference';

describe('resolveDefaultSourceBranch', () => {
  test('starts from the branch the project root is on', () => {
    expect(resolveDefaultSourceBranch({ branches: ['develop', 'main'], rootBranch: 'develop' })).toBe('develop');
  });

  test('falls back to main, then master, then the first branch', () => {
    expect(resolveDefaultSourceBranch({ branches: ['feature/x', 'main'], rootBranch: null })).toBe('main');
    expect(resolveDefaultSourceBranch({ branches: ['feature/x', 'master'], rootBranch: 'gone' })).toBe('master');
    expect(resolveDefaultSourceBranch({ branches: ['feature/x'], rootBranch: null })).toBe('feature/x');
    expect(resolveDefaultSourceBranch({ branches: [], rootBranch: null })).toBe('');
  });
});

describe('resolveBranchOnTopSource', () => {
  test('starts on the local copy, else the copy on origin, else on another remote', () => {
    expect(resolveBranchOnTopSource(['feat/a', 'remotes/origin/feat/a'], 'feat/a')).toBe('feat/a');
    expect(resolveBranchOnTopSource(['main', 'remotes/upstream/feat/a', 'remotes/origin/feat/a'], 'feat/a')).toBe('remotes/origin/feat/a');
    expect(resolveBranchOnTopSource(['main', 'remotes/upstream/feat/a'], 'feat/a')).toBe('remotes/upstream/feat/a');
    expect(resolveBranchOnTopSource(['main', 'remotes/origin/other/feat/a'], 'feat/a')).toBe('');
  });
});

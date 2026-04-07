#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const explicitFiles = args.filter((arg) => arg !== '--staged');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmRun(script, extraArgs = []) {
  run('npm', ['run', script, '--', ...extraArgs]);
}

function readGitPaths(args) {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function detectChangedFiles() {
  if (stagedOnly) {
    return readGitPaths(['diff', '--name-only', '--cached']);
  }
  return [
    ...readGitPaths(['diff', '--name-only', '--cached']),
    ...readGitPaths(['diff', '--name-only']),
    ...readGitPaths(['ls-files', '--others', '--exclude-standard']),
  ];
}

function uniqueExistingFiles(files) {
  return [...new Set(files)].filter((file) => existsSync(file));
}

function isDocLike(file) {
  return (
    file.endsWith('.md') ||
    file.endsWith('.mdc') ||
    file.startsWith('docs/') ||
    file.startsWith('.ai/') ||
    file === 'README.md' ||
    file === 'CLAUDE.md' ||
    file === 'AGENTS.md'
  );
}

function isLintable(file) {
  return (
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.js') ||
    file.endsWith('.mjs') ||
    file.endsWith('.cjs')
  );
}

const changedFiles = uniqueExistingFiles(explicitFiles.length > 0 ? explicitFiles : detectChangedFiles());
const label = stagedOnly ? 'lint:smart:staged' : 'lint:smart';

if (changedFiles.length === 0) {
  console.log(`[${label}] No changed files detected; skipping lint.`);
  process.exit(0);
}

if (changedFiles.every(isDocLike)) {
  console.log(`[${label}] Only docs/rules changed; skipping lint.`);
  process.exit(0);
}

const lintableFiles = changedFiles.filter((file) => isLintable(file) && !isDocLike(file));

if (lintableFiles.length === 0) {
  console.log(`[${label}] No lintable changed files detected; skipping lint.`);
  process.exit(0);
}

if (explicitFiles.length === 0 && lintableFiles.length > 30) {
  console.log(
    `[${label}] ${lintableFiles.length} lintable changed files detected; falling back to full lint.`,
  );
  npmRun('lint');
  process.exit(0);
}

console.log(`[${label}] Linting changed files: ${lintableFiles.join(', ')}`);
npmRun('lint:file', lintableFiles);

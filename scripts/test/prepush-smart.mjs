#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';

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

function readGit(args) {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function readGitLines(args) {
  const output = readGit(args);
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function matches(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

const upstream = readGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);

const heavyPatterns = [
  /^test\/integration\/search-pipeline\.test\.ts$/,
  /^src\/application\/search\//,
  /^src\/domain\/decision\//,
  /^src\/domain\/query\//,
  /^src\/domain\/retrieval\//,
  /^src\/domain\/response\//,
  /^src\/infrastructure\/vespa\//,
];

const httpContractPatterns = [
  /^src\/interface\/http\//,
  /^docs\/http-contract-surface\.md$/,
  /^data\/http-contract-manifest\.json$/,
  /^scripts\/export-http-contract-manifest\.ts$/,
  /^web\/src\/shared\/api\/ops-types\.ts$/,
  /^app\/entity-lookup-ops-web\/src\/lib\/api\.ts$/,
];

function fallbackPrepush(files) {
  const script = files.some((file) => matches(file, heavyPatterns))
    ? 'git:prepush:heavy'
    : 'git:prepush';
  console.log(`[git:prepush:smart] Falling back to ${script}.`);
  npmRun(script);
}

if (!upstream) {
  const localChanges = readGitLines(['diff', '--name-only', '--cached'])
    .concat(readGitLines(['diff', '--name-only']))
    .concat(readGitLines(['ls-files', '--others', '--exclude-standard']));
  console.log('[git:prepush:smart] No upstream branch detected; choosing safe fallback.');
  fallbackPrepush(localChanges);
  process.exit(0);
}

const changedFiles = readGitLines(['diff', '--name-only', `${upstream}...HEAD`]);

if (changedFiles.length === 0) {
  console.log(`[git:prepush:smart] No changes relative to ${upstream}; skipping pre-push checks.`);
  process.exit(0);
}

if (changedFiles.length > 25) {
  console.log(
    `[git:prepush:smart] ${changedFiles.length} changed files relative to ${upstream}; falling back to full git:prepush.`,
  );
  fallbackPrepush(changedFiles);
  process.exit(0);
}

console.log(
  `[git:prepush:smart] Using smart branch diff against ${upstream}: ${changedFiles.join(', ')}`,
);

npmRun('check:smart', changedFiles);

if (changedFiles.some((file) => matches(file, httpContractPatterns))) {
  console.log('[git:prepush:smart] HTTP-contract-sensitive changes detected; running verify:http-contracts.');
  npmRun('verify:http-contracts');
}

if (changedFiles.some((file) => matches(file, heavyPatterns))) {
  console.log('[git:prepush:smart] Search-pipeline-sensitive changes detected; running test:heavy.');
  npmRun('test:heavy');
}

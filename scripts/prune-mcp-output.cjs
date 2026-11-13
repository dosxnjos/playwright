#!/usr/bin/env node
/**
 * One-off prune of `.playwright-mcp` output folders with the same rule the wrapper applies on
 * every launch (run-mcp-server.cjs, pruneOutputDir): first-level files with a server-generated
 * name, older than the retention. Never a subfolder, never a chosen name.
 *
 *   node scripts/prune-mcp-output.cjs [--dry-run] [--days N] <output folder>...
 *
 * Each argument is the output folder itself (e.g. C:\Dev\unclick\.playwright-mcp). --days defaults
 * to PLAYWRIGHT_MCP_OUTPUT_RETENTION_DAYS or 7; 0 is refused here (it would mean "prune nothing").
 * Prints, per folder, the entries before/after, how many files went (or would go) and their size.
 * Exit 1 if any folder had an error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pruneOutputDir, retentionDays } = require('./run-mcp-server.cjs');

function countEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let days = retentionDays(process.env);
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run')
      dryRun = true;
    else if (args[i] === '--days')
      days = Number(args[++i]);
    else
      dirs.push(path.resolve(args[i]));
  }
  if (!dirs.length || !Number.isFinite(days) || days <= 0) {
    process.stderr.write('usage: node scripts/prune-mcp-output.cjs [--dry-run] [--days N>0] <output folder>...\n');
    process.exit(2);
  }
  let failed = false;
  let totalRemoved = 0;
  let totalBytes = 0;
  for (const dir of dirs) {
    const before = countEntries(dir);
    if (before === null) {
      process.stdout.write(`${dir}: missing, skipped\n`);
      continue;
    }
    const result = await pruneOutputDir(dir, { days, dryRun, log: message => process.stderr.write(message + '\n') });
    const after = countEntries(dir);
    totalRemoved += result.removed;
    totalBytes += result.bytes;
    failed = failed || result.errors > 0;
    process.stdout.write(`${dir}: entries ${before} -> ${after}, ${dryRun ? 'would remove' : 'removed'} ${result.removed} ` +
      `of ${result.scanned} generated, ${(result.bytes / 1024 / 1024).toFixed(1)} MB, errors ${result.errors}\n`);
  }
  process.stdout.write(`total: ${dryRun ? 'would remove' : 'removed'} ${totalRemoved} file(s), ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB, retention ${days} day(s)${dryRun ? ' (dry run, nothing deleted)' : ''}\n`);
  process.exitCode = failed ? 1 : 0;
}

main();

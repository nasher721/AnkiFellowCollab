import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('PowerShell native command helper forwards all remaining arguments', () => {
  const helperPath = path.resolve(process.cwd(), 'scripts', 'native-command.ps1');
  const command = [
    `. '${helperPath.replaceAll("'", "''")}'`,
    `Invoke-NativeCommand node -e "if (process.argv[1] !== 'alpha' || process.argv[2] !== 'beta') process.exit(7)" alpha beta`
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PowerShell storage helper falls back to current Supabase volume mount', () => {
  const helperPath = path.resolve(process.cwd(), 'scripts', 'supabase-storage-path.ps1');
  const command = [
    `. '${helperPath.replaceAll("'", "''")}'`,
    `$resolved = Resolve-SupabaseStorageContainerPath storage-container -PathExists { param($container, $candidate) $candidate -eq '/mnt' }`,
    `if ($resolved -ne '/mnt') { throw "expected /mnt, got $resolved" }`
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

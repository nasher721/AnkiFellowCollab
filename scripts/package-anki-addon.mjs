import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../server/ankiPackage.mjs';

const root = process.cwd();
const sourceDir = path.join(root, 'addons', 'deckbridge_sync');
const distDir = path.join(root, 'dist');
const outputPath = path.join(distDir, 'deckbridge-sync.ankiaddon');

await fs.mkdir(distDir, { recursive: true });
await runCommand('python3', ['-m', 'zipfile', '-c', outputPath, '__init__.py', 'manifest.json', 'config.json', 'README.md'], {
  cwd: sourceDir
});

console.log(outputPath);

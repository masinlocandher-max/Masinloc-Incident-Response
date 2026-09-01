import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const sourceArgIndex = process.argv.indexOf('--source');
if (sourceArgIndex === -1 || !process.argv[sourceArgIndex + 1]) {
  console.error('Usage: node scripts/import-pinned-upstream.mjs --source <checked-out-upstream-dir>');
  process.exit(2);
}

const sourceRoot = path.resolve(root, process.argv[sourceArgIndex + 1]);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'migration', 'upstream-blobs.json'), 'utf8'));

let actualCommit = '';
try {
  actualCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.error(`Cannot determine upstream commit in ${sourceRoot}`);
  process.exit(1);
}

if (actualCommit !== lock.source_commit) {
  console.error(`Refusing mixed-source import. Expected ${lock.source_commit}, got ${actualCommit}.`);
  process.exit(1);
}

for (const entry of lock.files.filter(file => file.required)) {
  const source = path.join(sourceRoot, entry.source_path);
  const target = path.join(root, entry.target_path);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    console.error(`Pinned upstream file is missing: ${entry.source_path}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`COPIED ${entry.source_path} -> ${entry.target_path}`);
}

console.log(`Imported ${lock.files.filter(file => file.required).length} pinned files from ${lock.source_repository}@${lock.source_commit}.`);

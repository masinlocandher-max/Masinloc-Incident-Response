import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

const root = process.cwd();
const allowMissing = process.argv.includes('--allow-missing');
const lockPath = path.join(root, 'migration', 'upstream-blobs.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

let missing = 0;
let mismatch = 0;
let match = 0;

console.log(`Pinned upstream: ${lock.source_repository}@${lock.source_commit}`);
for (const entry of lock.files.filter(file => file.required)) {
  // Older locks used `sha`; the repository-side lock generator uses the more
  // explicit `blob_sha`. Supporting both lets us rotate source checkpoints
  // without weakening the byte-for-byte comparison.
  const expected = entry.sha || entry.blob_sha;
  if (!expected) {
    mismatch += 1;
    console.log(`MISMATCH ${entry.target_path}`);
    console.log('         expected hash missing from lock entry');
    continue;
  }

  const localPath = path.join(root, entry.target_path);
  if (!fs.existsSync(localPath)) {
    missing += 1;
    console.log(`MISSING  ${entry.target_path}  expected ${expected}`);
    continue;
  }

  const actual = gitBlobSha(fs.readFileSync(localPath));
  if (actual !== expected) {
    mismatch += 1;
    console.log(`MISMATCH ${entry.target_path}`);
    console.log(`         expected ${expected}`);
    console.log(`         actual   ${actual}`);
    continue;
  }

  match += 1;
  console.log(`MATCH    ${entry.target_path}  ${actual}`);
}

console.log(`\nParity summary: ${match} match, ${missing} missing, ${mismatch} mismatch.`);

if (mismatch > 0) {
  console.error('FAIL: at least one migrated file differs from the pinned production source.');
  process.exit(1);
}
if (missing > 0 && !allowMissing) {
  console.error('FAIL: required upstream files are still missing. Cutover is blocked.');
  process.exit(1);
}
if (missing > 0 && allowMissing) {
  console.log('Migration-progress mode: missing files are reported but permitted. This is NOT a cutover pass.');
}

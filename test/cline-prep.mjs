// Prepares a folder for test/cline-check.ps1: hello.xlsx, calc.py, doc.pdf.
// Usage: node test/cline-prep.mjs <dir>
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFixtures } from './fixtures.mjs';

const dir = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node test/cline-prep.mjs <dir>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
writeFixtures(dir);
copyFileSync(join(dir, 'input.pdf'), join(dir, 'doc.pdf'));
// check 6 needs a .env that exists: without it the server answers 404 and the 403 secret path is not tested
writeFileSync(join(dir, '.env'), 'DUMMY_KEY=not-a-real-secret\n');
for (const f of ['hello.xlsx', 'doc.pdf', 'calc.py', '.env']) {
  if (!existsSync(join(dir, f))) {
    console.error('missing ' + f);
    process.exit(1);
  }
}
console.log('ready: ' + dir);

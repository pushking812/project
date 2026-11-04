// Prepares a folder for test/cline-check.ps1: hello.xlsx, calc.py, doc.pdf.
// Usage: node test/cline-prep.mjs <dir>
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
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
for (const f of ['hello.xlsx', 'doc.pdf', 'calc.py']) {
  if (!existsSync(join(dir, f))) {
    console.error('missing ' + f);
    process.exit(1);
  }
}
console.log('ready: ' + dir);

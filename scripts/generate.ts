/**
 * Generates src/api/generated/ from openapi/openapi.json.
 *
 *   npm run generate            write the files
 *   npm run generate -- --check fail if the committed files are out of date
 *
 * See scripts/codegen.ts for what is generated and how.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, type OpenApiDocument } from './codegen.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = JSON.parse(
  readFileSync(join(root, 'openapi', 'openapi.json'), 'utf8'),
) as OpenApiDocument;
const files = await generate(doc, join(root, '.prettierrc.json'));
const check = process.argv.includes('--check');

let stale = 0;
for (const [path, content] of files) {
  const full = join(root, path);
  if (check) {
    let current = '';
    try {
      current = readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // Missing counts as stale.
    }
    if (current !== content) {
      console.error(`out of date: ${path}`);
      stale++;
    }
  } else {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    console.log(`wrote ${path}`);
  }
}
if (stale > 0) {
  console.error('Run `npm run generate` and commit the result.');
  process.exit(1);
}

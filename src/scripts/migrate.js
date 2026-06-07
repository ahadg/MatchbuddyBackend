import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../db.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const sqlDir = path.resolve(currentDir, '../../sql');

const files = (await fs.readdir(sqlDir)).filter((file) => file.endsWith('.sql')).sort();

for (const file of files) {
  const sql = await fs.readFile(path.join(sqlDir, file), 'utf8');
  console.log(`Applying ${file}`);
  await db.query(sql);
}

await db.end();
console.log('Migrations complete.');

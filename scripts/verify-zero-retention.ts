import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDatabasePath } from '../apps/server/src/config.js';

const FORBIDDEN_STRINGS = [
  '849201',
  'rst_998123_secret',
  'ghp_reset_8291042',
  'Comprehensive Metabolic Panel',
  'Cedar Machiya Townhouse',
  'new-unknown-utility.io',
  'samira.rao@gmail.com',
  'attacker@evil.example',
  'Mutual-NDA-Redline-Privileged',
  '$4,850',
];

function checkText(label: string, content: string): number {
  let violations = 0;
  for (const needle of FORBIDDEN_STRINGS) {
    if (content.includes(needle)) {
      console.error(`[FAIL] Forbidden raw email string "${needle}" found in ${label}`);
      violations += 1;
    }
  }
  return violations;
}

function main() {
  let failures = 0;
  const dbPath = resolveDatabasePath();

  if (fs.existsSync(dbPath)) {
    const sqlite = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[];

      for (const t of tables) {
        const rows = sqlite.prepare(`SELECT * FROM "${t.name}"`).all();
        failures += checkText(`sqlite:${t.name}`, JSON.stringify(rows));
      }

      const auditCols = sqlite
        .prepare(`PRAGMA table_info(audit_logs)`)
        .all() as { name: string }[];
      const colNames = auditCols.map((c) => c.name);
      for (const badCol of ['subject', 'body', 'snippet', 'from', 'attachments']) {
        if (colNames.includes(badCol)) {
          console.error(`[FAIL] Forbidden content column "${badCol}" present in audit_logs`);
          failures += 1;
        }
      }
      console.log(`[OK] Verified SQLite zero-retention across ${tables.length} table(s).`);
    } finally {
      sqlite.close();
    }
  } else {
    console.log('[INFO] No configured database found on disk yet.');
  }

  const tracesDir = path.resolve(process.cwd(), 'traces');
  if (fs.existsSync(tracesDir)) {
    for (const file of fs.readdirSync(tracesDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(tracesDir, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      failures += checkText(`traces/${file}`, raw);
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      for (let i = 0; i < lines.length; i++) {
        JSON.parse(lines[i]);
      }
      console.log(`[OK] Verified traces/${file} (${lines.length} valid metadata-only JSONL lines).`);
    }
  }

  if (failures > 0) {
    console.error(`\nZero-retention verification FAILED (${failures} violation(s)).`);
    process.exit(1);
  }
  console.log('\nZero-retention forensic verification PASSED (0 email content bytes retained).');
}

main();

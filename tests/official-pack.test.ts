import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { runOfficialPack } from '../apps/server/src/inbox/officialPack.js';
import { verifyTrace } from '../apps/server/src/inbox/trace.js';

it('ingests supplied formats in isolation and links each degraded or quarantined result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'siftvane-pack-'));
  try {
    await writeFile(path.join(root, 'mismatch.eml'), 'From: sender@example.test\nReply-To: other@outside.test\nSubject: A sample\n\nMessage body.');
    await writeFile(path.join(root, 'note.json'), '{"subject":"Ordinary note","body":"Hello from the isolated test fixture."}');
    await writeFile(path.join(root, 'bad.pdf'), 'Synthetic malformed input');
    await writeFile(path.join(root, 'note.txt'), 'Unclassified text');
    await writeFile(path.join(root, 'note.md'), 'Unclassified markdown');
    await writeFile(path.join(root, 'note.html'), '<p>Unclassified HTML</p>');
    const names = ['mismatch.eml', 'note.json', 'bad.pdf', 'note.txt', 'note.md', 'note.html', '../untrusted.txt'];
    const manifest = path.join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ files: names }));
    const output = await runOfficialPack(manifest, { traces: path.join(root, 'traces'), report: path.join(root, 'report.md') });
    expect(output.passed).toBe(false);
    expect(output.results).toHaveLength(7);
    expect(output.results[0]).toMatchObject({ mode: 'offline-smoke', outcome: 'QUARANTINED', policy_rule_id: 'SENDER_REPLY_TO_MISMATCH' });
    expect(output.results[1]).toMatchObject({ status: 'DEGRADED', outcome: 'ESCALATED' });
    expect(output.results[2]).toMatchObject({ outcome: 'QUARANTINED', policy_rule_id: 'INPUT_PARSE' });
    expect(output.results[6]).toMatchObject({ status: 'DEGRADED', policy_rule_id: 'PACK_INPUT_PATH_REJECTED' });
    for (const row of output.results) {
      expect(row.unauthorized_side_effects).toBe(0);
      expect(verifyTrace(JSON.parse(await readFile(row.trace_path, 'utf8')))).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

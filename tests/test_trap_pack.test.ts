import { expect, it } from 'vitest';
import { runInboxTrapPack } from '../apps/server/src/inbox/trapHarness.js';

it('isolates all five traps and recovers a timed-out provider receipt without a duplicate', async () => {
  const report = await runInboxTrapPack();
  expect(report.case_count).toBe(5);
  expect(report.cases).toHaveLength(7);
  expect(report.cases.filter((entry) => !entry.passed)).toEqual([]);
  expect(report.passed).toBe(true);
});

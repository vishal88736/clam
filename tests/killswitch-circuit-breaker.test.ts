import { describe, expect, it } from 'vitest';
import { createSiftvaneApp } from '../apps/server/src/app.js';

describe('Emergency stop', () => {
  it('aborts in-flight AbortController registrations immediately upon Kill Switch engage', async () => {
    const runtime = await createSiftvaneApp({ databasePath: ':memory:' });
    try {
      const controller = new AbortController();
      let abortedFired = false;
      controller.signal.addEventListener('abort', () => {
        abortedFired = true;
      });

      const unregister = runtime.killSwitchService.registerInFlight(
        'run_inflight_test',
        'ag_autonomous',
        controller
      );
      expect(runtime.killSwitchService.getState().active_runs_count).toBe(1);

      const state = await runtime.killSwitchService.engage({
        triggerMode: 'manual_ui',
        reason: 'Aborting in-flight operation',
      });

      expect(abortedFired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(state.aborted_inflight_count).toBe(1);
      expect(state.active_runs_count).toBe(0);
      unregister();
    } finally {
      await runtime.close();
    }
  });
});

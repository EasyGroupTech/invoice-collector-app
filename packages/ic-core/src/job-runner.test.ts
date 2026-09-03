import { describe, expect, it, vi } from 'vitest';
import { createJobRunner } from './job-runner.js';

describe('createJobRunner', () => {
  it('runs a job and emits progress + a successful done event', async () => {
    const runner = createJobRunner();
    const progressEvents: unknown[] = [];
    const doneEvents: unknown[] = [];
    runner.onProgress((e) => progressEvents.push(e));
    runner.onDone((e) => doneEvents.push(e));

    const handle = runner.runJob('collect', async (report) => {
      report({ message: 'step 1' });
      report({ message: 'step 2' });
      return { total: 2 };
    });

    expect(handle.jobId).toBeTruthy();
    await vi.waitFor(() => expect(doneEvents).toHaveLength(1));

    expect(progressEvents).toEqual([
      { jobId: handle.jobId, kind: 'collect', message: 'step 1' },
      { jobId: handle.jobId, kind: 'collect', message: 'step 2' },
    ]);
    expect(doneEvents[0]).toEqual({ jobId: handle.jobId, kind: 'collect', ok: true, result: { total: 2 } });
  });

  it('emits a failed done event with the error message when the job throws', async () => {
    const runner = createJobRunner();
    const doneEvents: unknown[] = [];
    runner.onDone((e) => doneEvents.push(e));

    runner.runJob('collect', async () => {
      throw new Error('boom');
    });

    await vi.waitFor(() => expect(doneEvents).toHaveLength(1));
    expect(doneEvents[0]).toEqual({ jobId: expect.any(String), kind: 'collect', ok: false, error: 'boom' });
  });

  it('cancelJob aborts the running job\'s signal', async () => {
    const runner = createJobRunner();
    let observedAborted = false;

    const handle = runner.runJob('collect', async (_report, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observedAborted = true;
          resolve();
        });
      });
      return 'done';
    });

    runner.cancelJob(handle.jobId);
    await vi.waitFor(() => expect(observedAborted).toBe(true));
  });

  it('hasActiveJobs reflects whether any job is currently running', async () => {
    const runner = createJobRunner();
    expect(runner.hasActiveJobs()).toBe(false);

    let resolveJob!: () => void;
    runner.runJob('collect', () => new Promise<void>((resolve) => (resolveJob = resolve)));

    expect(runner.hasActiveJobs()).toBe(true);
    resolveJob();
    await vi.waitFor(() => expect(runner.hasActiveJobs()).toBe(false));
  });

  it('onProgress/onDone subscriptions return an unsubscribe function', async () => {
    const runner = createJobRunner();
    const events: unknown[] = [];
    const unsubscribe = runner.onProgress((e) => events.push(e));
    unsubscribe();

    runner.runJob('collect', async (report) => {
      report({ message: 'should not be observed' });
      return 'x';
    });

    await vi.waitFor(() => expect(runner.hasActiveJobs()).toBe(false));
    expect(events).toEqual([]);
  });

  it('runs two distinct jobs concurrently, each tracked by its own id', async () => {
    const runner = createJobRunner();
    const doneEvents: Array<{ jobId: string }> = [];
    runner.onDone((e) => doneEvents.push(e as { jobId: string }));

    const a = runner.runJob('collect', async () => 'a');
    const b = runner.runJob('sign-in', async () => 'b');

    expect(a.jobId).not.toBe(b.jobId);
    await vi.waitFor(() => expect(doneEvents).toHaveLength(2));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createCollectJobGuard } from './collect-job-guard.js';
import { createJobRunner } from './job-runner.js';

describe('createCollectJobGuard', () => {
  it('starts a collect job when none is running', () => {
    const jobRunner = createJobRunner();
    const guard = createCollectJobGuard(jobRunner);

    const result = guard.startCollect(async () => ({ outcomes: [] }));

    expect('jobId' in result).toBe(true);
    expect(guard.isCollectRunning()).toBe(true);
  });

  it('refuses a second concurrent collect job', () => {
    const jobRunner = createJobRunner();
    const guard = createCollectJobGuard(jobRunner);
    let resolveFirst!: () => void;

    guard.startCollect(() => new Promise((resolve) => (resolveFirst = () => resolve({ outcomes: [] }))));
    const second = guard.startCollect(async () => ({ outcomes: [] }));

    expect('error' in second).toBe(true);
    resolveFirst();
  });

  it('allows a new collect job once the previous one finishes', async () => {
    const jobRunner = createJobRunner();
    const guard = createCollectJobGuard(jobRunner);

    guard.startCollect(async () => ({ outcomes: [] }));
    await vi.waitFor(() => expect(guard.isCollectRunning()).toBe(false));

    const second = guard.startCollect(async () => ({ outcomes: [] }));
    expect('jobId' in second).toBe(true);
  });

  it('clears the running flag even when the collect job throws', async () => {
    const jobRunner = createJobRunner();
    const guard = createCollectJobGuard(jobRunner);

    guard.startCollect(async () => {
      throw new Error('boom');
    });
    await vi.waitFor(() => expect(guard.isCollectRunning()).toBe(false));

    expect('jobId' in guard.startCollect(async () => ({ outcomes: [] }))).toBe(true);
  });

  it('does not block an unrelated (non-collect) job on the underlying job runner', () => {
    const jobRunner = createJobRunner();
    const guard = createCollectJobGuard(jobRunner);

    guard.startCollect(() => new Promise(() => {})); // never resolves
    const otherJob = jobRunner.runJob('sign-in', async () => 'ok');

    expect(otherJob.jobId).toBeTruthy();
  });
});

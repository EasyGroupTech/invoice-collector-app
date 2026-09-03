import type { CollectRunResult } from './collect-pipeline.js';
import type { JobHandle, JobRunner, ProgressReporter } from './job-runner.js';

export type StartCollectResult = JobHandle | { error: string };

/**
 * Enforces "two collect jobs must never run concurrently" (CLAUDE.md's concurrency constraint) —
 * scoped to collect specifically, not JobRunner.hasActiveJobs() overall, since an unrelated job
 * kind (e.g. a device-code sign-in) was never part of that constraint and shouldn't be blocked by
 * it. The historical reason for the constraint (src/lib/billing.ts's process.env-based period
 * filter, §5) no longer exists in this architecture — discover() takes period as a plain argument
 * — but the constraint itself is kept as a deliberate v1 scope decision, not lifted just because
 * its original cause is gone.
 */
export interface CollectJobGuard {
  isCollectRunning(): boolean;
  startCollect(fn: (report: ProgressReporter, signal: AbortSignal) => Promise<CollectRunResult>): StartCollectResult;
}

export function createCollectJobGuard(jobRunner: JobRunner): CollectJobGuard {
  let runningJobId: string | undefined;

  return {
    isCollectRunning() {
      return runningJobId !== undefined;
    },

    startCollect(fn) {
      if (runningJobId !== undefined) {
        return { error: 'A collect run is already in progress' };
      }

      const handle = jobRunner.runJob('collect', fn);
      runningJobId = handle.jobId;

      const unsubscribe = jobRunner.onDone((event) => {
        if (event.jobId === handle.jobId) {
          runningJobId = undefined;
          unsubscribe();
        }
      });

      return handle;
    },
  };
}

import { useCallback, useRef, useState } from 'react';
import type { JobHandle, JobProgressEvent } from '../../../electron/shared/ipcContracts';

export type JobOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

export interface UseJobResult<T> {
  jobId: string | undefined;
  /** Every progress event for this job, in arrival order — unlike `jobs.ts`'s `runJobAndWait()`,
   * which only ever surfaces the terminal result, this is for a caller that needs to react to
   * *what's happening* while a job is still running (the device-code flow's own "here's the URL
   * and code to enter" is exactly this — with no way to see it, that sign-in is unusable). */
  progressLog: JobProgressEvent[];
  result: JobOutcome<T> | undefined;
  start: (startJob: Promise<JobHandle>) => Promise<void>;
  cancel: () => void;
}

/** Port of the reference app's own `useJob` hook, adapted to this repo's actual `JobProgressEvent`/
 * `JobDoneEvent` shapes (`event.data`, not flattened top-level fields) — this app has no
 * per-job-lifecycle hook of its own yet; `CollectPage.tsx`'s own inline `onJobProgress` subscriber
 * gets away without one only because at most one job ever runs there at a time, which doesn't
 * generalize to a dialog that might create more than one session in the same session. */
export function useJob<T>(): UseJobResult<T> {
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [progressLog, setProgressLog] = useState<JobProgressEvent[]>([]);
  const [result, setResult] = useState<JobOutcome<T> | undefined>(undefined);
  const jobIdRef = useRef<string | undefined>(undefined);

  const start = useCallback(async (startJob: Promise<JobHandle>) => {
    setProgressLog([]);
    setResult(undefined);
    const handle = await startJob;
    jobIdRef.current = handle.jobId;
    setJobId(handle.jobId);

    const unsubscribeProgress = window.api.onJobProgress((event) => {
      if (event.jobId !== jobIdRef.current) return;
      setProgressLog((prev) => [...prev, event]);
    });
    const unsubscribeDone = window.api.onJobDone((event) => {
      if (event.jobId !== jobIdRef.current) return;
      unsubscribeProgress();
      unsubscribeDone();
      setResult(event.ok ? { ok: true, result: event.result as T } : { ok: false, error: event.error });
    });
  }, []);

  const cancel = useCallback(() => {
    if (jobIdRef.current) void window.api.jobsCancel(jobIdRef.current);
  }, []);

  return { jobId, progressLog, result, start, cancel };
}

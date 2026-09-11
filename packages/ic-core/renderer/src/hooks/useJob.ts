import { useCallback, useRef, useState } from 'react';
import type { JobDoneEvent, JobHandle, JobProgressEvent } from '../../../electron/shared/ipcContracts';

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
    jobIdRef.current = undefined;

    // Subscribed *before* startJob is even awaited, and buffered until its own jobId is known —
    // a job whose failure requires no real async work at all (e.g. a session type with no input
    // to resolve) can run, fail, and broadcast its own done event before this hook ever learns its
    // jobId from startJob's resolution. Confirmed live: registering the real onJobDone listener
    // only afterward (the previous code here) missed that event entirely, leaving `result` stuck
    // undefined forever — a job that's actually finished looking, to the caller, exactly like one
    // still in progress. Boxed (rather than a bare `let`) so the two closures below observe later
    // mutations of `.jobId`/`.done` rather than whatever value was in scope when they were created.
    const pending: { jobId: string | undefined; done: JobDoneEvent | undefined } = { jobId: undefined, done: undefined };
    const bufferedProgress: JobProgressEvent[] = [];

    const unsubscribeProgress = window.api.onJobProgress((event) => {
      if (pending.jobId === undefined) {
        bufferedProgress.push(event);
        return;
      }
      if (event.jobId !== pending.jobId) return;
      setProgressLog((prev) => [...prev, event]);
    });
    const unsubscribeDone = window.api.onJobDone((event) => {
      if (pending.jobId === undefined) {
        pending.done = event; // only one job per start() call, so the latest is the right one
        return;
      }
      if (event.jobId !== pending.jobId) return;
      unsubscribeProgress();
      unsubscribeDone();
      setResult(event.ok ? { ok: true, result: event.result as T } : { ok: false, error: event.error });
    });

    const handle = await startJob;
    pending.jobId = handle.jobId;
    jobIdRef.current = handle.jobId;
    setJobId(handle.jobId);

    const ownBufferedProgress = bufferedProgress.filter((event) => event.jobId === pending.jobId);
    if (ownBufferedProgress.length > 0) setProgressLog((prev) => [...prev, ...ownBufferedProgress]);

    if (pending.done && pending.done.jobId === pending.jobId) {
      unsubscribeProgress();
      unsubscribeDone();
      setResult(pending.done.ok ? { ok: true, result: pending.done.result as T } : { ok: false, error: pending.done.error });
    }
  }, []);

  const cancel = useCallback(() => {
    if (jobIdRef.current) void window.api.jobsCancel(jobIdRef.current);
  }, []);

  return { jobId, progressLog, result, start, cancel };
}

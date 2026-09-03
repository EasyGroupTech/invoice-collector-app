import { randomUUID } from 'node:crypto';

export type ProgressReporter = (update: { message: string; sourceId?: string; data?: Record<string, unknown> }) => void;

export interface JobHandle {
  jobId: string;
}

export interface JobProgressEvent {
  jobId: string;
  kind: string;
  message: string;
  sourceId?: string;
  data?: Record<string, unknown>;
}

export type JobDoneEvent<T = unknown> =
  | { jobId: string; kind: string; ok: true; result: T }
  | { jobId: string; kind: string; ok: false; error: string };

type Listener<T> = (event: T) => void;
type Unsubscribe = () => void;

/**
 * Electron-free port of the reference app's electron/main/jobs.ts — every long-running action
 * (device-code polling, a collect run) goes through this instead of bespoke per-feature progress
 * plumbing. Progress/done events are emitted to subscribers rather than sent directly over IPC —
 * the Electron shell (phase 1.11) is what wires a subscription to `webContents.send`, and a real
 * persisted log; this module only needs the mechanism, not the transport.
 */
export interface JobRunner {
  runJob<T>(kind: string, fn: (report: ProgressReporter, signal: AbortSignal) => Promise<T>): JobHandle;
  cancelJob(jobId: string): void;
  hasActiveJobs(): boolean;
  onProgress(listener: Listener<JobProgressEvent>): Unsubscribe;
  onDone(listener: Listener<JobDoneEvent>): Unsubscribe;
}

export function createJobRunner(): JobRunner {
  const activeJobs = new Map<string, AbortController>();
  const progressListeners = new Set<Listener<JobProgressEvent>>();
  const doneListeners = new Set<Listener<JobDoneEvent>>();

  function runJob<T>(kind: string, fn: (report: ProgressReporter, signal: AbortSignal) => Promise<T>): JobHandle {
    const jobId = randomUUID();
    const controller = new AbortController();
    activeJobs.set(jobId, controller);

    const report: ProgressReporter = (update) => {
      const event: JobProgressEvent = { jobId, kind, ...update };
      for (const listener of progressListeners) listener(event);
    };

    fn(report, controller.signal)
      .then((result) => {
        const event: JobDoneEvent<T> = { jobId, kind, ok: true, result };
        for (const listener of doneListeners) listener(event);
      })
      .catch((err: unknown) => {
        const event: JobDoneEvent<T> = { jobId, kind, ok: false, error: err instanceof Error ? err.message : String(err) };
        for (const listener of doneListeners) listener(event);
      })
      .finally(() => {
        activeJobs.delete(jobId);
      });

    return { jobId };
  }

  return {
    runJob,

    cancelJob(jobId) {
      activeJobs.get(jobId)?.abort();
    },

    hasActiveJobs() {
      return activeJobs.size > 0;
    },

    onProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },

    onDone(listener) {
      doneListeners.add(listener);
      return () => doneListeners.delete(listener);
    },
  };
}

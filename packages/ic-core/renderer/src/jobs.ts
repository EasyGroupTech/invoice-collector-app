/** `sessionsCreate`/`sessionsReconnect`/`collectRun` all return a bare `JobHandle` (§ job-runner.ts)
 * — the real result arrives later via the onJobDone event, matched by jobId. This turns that
 * event-plus-handle pair back into a single awaitable promise for a page that just wants "did it
 * work, and what came back," without hand-rolling the same matching logic in every page. */
export function waitForJobDone<T>(jobId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsubscribe = window.api.onJobDone((event) => {
      if (event.jobId !== jobId) return;
      unsubscribe();
      if (event.ok) resolve(event.result as T);
      else reject(new Error(event.error));
    });
  });
}

export async function runJobAndWait<T>(startJob: Promise<{ jobId: string }>): Promise<T> {
  const handle = await startJob;
  return waitForJobDone<T>(handle.jobId);
}

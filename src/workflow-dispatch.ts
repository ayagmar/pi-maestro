import { claimTaskDispatch, releaseTaskDispatch, renewTaskDispatch } from "./board.js";

export type DispatchKind = "execute" | "review";

export function claimDispatchLifecycle(
  cwd: string,
  taskId: string,
  kind: DispatchKind,
  dispatchable: Parameters<typeof claimTaskDispatch>[3]
) {
  const dispatch = claimTaskDispatch(cwd, taskId, kind, dispatchable);
  if (!dispatch?.claimed) return { dispatch };

  let leaseMs: number | undefined;
  let releasing = false;
  let closed = false;
  const release = () => {
    if (closed) return;
    releasing = true;
    releaseTaskDispatch(cwd, taskId, dispatch.claimId);
    closed = true;
    clearInterval(renewal);
  };
  const renewal = setInterval(() => {
    try {
      if (releasing) release();
      else renewTaskDispatch(cwd, taskId, dispatch.claimId, leaseMs);
    } catch {
      // A contended or failing board write is retried on the next tick.
    }
  }, 10_000);
  renewal.unref();

  return {
    dispatch,
    extendLease: (durationMs: number) => {
      leaseMs = durationMs;
      renewTaskDispatch(cwd, taskId, dispatch.claimId, durationMs);
    },
    release,
  };
}

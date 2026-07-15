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

  const renewal = setInterval(() => {
    renewTaskDispatch(cwd, taskId, dispatch.claimId);
  }, 10_000);
  renewal.unref();
  let closed = false;

  return {
    dispatch,
    release: () => {
      if (closed) return;
      closed = true;
      clearInterval(renewal);
      releaseTaskDispatch(cwd, taskId, dispatch.claimId);
    },
  };
}

import { type ExecutorHandle, type RunUpdate } from "./runner.js";

export interface WorkflowRun {
  taskId: string;
  kind: "execute" | "review";
  turns: number;
  cost: number;
  lastActivity: string;
  handle: ExecutorHandle;
}

export type StartExecutor = typeof import("./runner.js").startExecutor;
export type WorkflowUpdate = (taskId: string, update: RunUpdate, kind: WorkflowRun["kind"]) => void;
export type TrackRun = (run: WorkflowRun) => () => void;

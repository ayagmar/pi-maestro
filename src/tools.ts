import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPlanTaskEdits,
  assertTaskNotDispatched,
  createTask,
  findTask,
  forceStatus,
  loadBoard,
  normalizeExistingTaskContract,
  normalizeTaskContract,
  normalizeWritePaths,
  planValidationMessage,
  updateBoard,
  updateTask,
  validatePlan,
} from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import {
  type BackgroundDrive,
  type DriveRuntimeController,
  resolveDriveDecision,
} from "./drive-controller.js";
import { STATUS_GLYPHS, STATUS_LABELS, taskLine, truncateText } from "./format.js";
import { assertPlanTaskLimit, preflightWorkflow } from "./preflight.js";
import { canonicalTaskIds } from "./session-control.js";
import { formatStatusProjection, projectStatus } from "./status.js";
import { type Task, type TaskStatus } from "./types.js";
import { type DriveSummary, formatDriveSummary, snapshot, type TaskSnapshot } from "./workflow.js";
import { parkInactiveWorktrees } from "./worktree.js";

interface MaestroDetails {
  action: string;
  tasks: TaskSnapshot[];
  rounds?: number;
  stoppedBecause?: DriveSummary["stoppedBecause"];
}

export interface ModelToolRuntime {
  pi: ExtensionAPI;
  adoptBoard(ctx: ExtensionContext): void;
  refreshUI(ctx: ExtensionContext): void;
  driveController: DriveRuntimeController;
  startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal
  ): BackgroundDrive;
}

export function registerMaestroTools(runtime: ModelToolRuntime): void {
  const { pi, adoptBoard, refreshUI, driveController, startBackgroundDrive } = runtime;
  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_plan",
    label: "Maestro Plan",
    description:
      "Create tasks on the maestro board. Each brief must be fully self-contained: executors run with a fresh context and see only the brief plus approved dependency reports. Tiers control executor model and thinking level (trivial, standard, complex).",
    promptSnippet: "Plan tasks for fresh-context executor agents (maestro board)",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short task title" }),
          brief: Type.String({
            description:
              "Self-contained instructions: goal, relevant file paths, constraints, acceptance criteria, verification command",
          }),
          kind: Type.Optional(
            StringEnum(["implementation", "investigation"] as const, {
              description:
                "implementation (default) changes files; investigation is explicit read-only/no-file work and requires writePaths: [].",
            })
          ),
          tier: Type.String({ description: "Complexity tier: trivial, standard, or complex" }),
          writePaths: Type.Array(Type.String(), {
            maxItems: 64,
            description:
              "Repository-relative files or directory/** scopes this task may change. Use [] only for explicit investigation/no-file work.",
          }),
          successCriteria: Type.Optional(
            Type.Array(Type.String({ maxLength: 500 }), {
              minItems: 1,
              maxItems: 12,
              description:
                "Explicit observable outcomes; optional for explicit investigation/no-file work.",
            })
          ),
          discovery: Type.Optional(
            Type.Object({
              allowedWritePaths: Type.Array(Type.String(), {
                minItems: 1,
                maxItems: 64,
                description:
                  "Repository-relative scopes generated tasks may write. The discovery task itself must be explicit read-only/no-file work with writePaths=[].",
              }),
            })
          ),
          verificationProfile: Type.Optional(
            Type.String({ description: "Trusted configured verification profile name" })
          ),
          reviewPolicy: Type.Optional(
            StringEnum(["single", "confirm", "find-and-refute"] as const, {
              description:
                "Review convergence policy. single is the default; confirm requires independent approvals; find-and-refute compares a finder with an independent refuter.",
            })
          ),
          commitMessage: Type.Optional(
            Type.String({
              description:
                "Conventional commit message (e.g. 'fix: handle empty board') used when this task's approved work is committed. Defaults to 'feat: <title>'.",
            })
          ),
          supersedesTaskId: Type.Optional(
            Type.String({
              description:
                "Failed, cancelled, or changes-requested predecessor this task replaces. Maestro atomically cancels it and rewires all downstream dependencies to this new task.",
            })
          ),
          dependsOn: Type.Optional(
            Type.Array(Type.String({ description: "Task id like T1" }), {
              description:
                "Tasks that must be approved before this one runs. Also chain tasks that would edit the same files: parallel executors on one working tree conflict.",
            })
          ),
        }),
        { description: "Tasks to add to the board" }
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const result = updateBoard(ctx.cwd, (board) => {
        assertPlanTaskLimit(board.tasks.length + (params.tasks as unknown[]).length, config);
        const initialTaskCount = board.tasks.length;
        const created: Task[] = [];
        const supersededTaskIds = new Set<string>();
        const supersessions: Array<{ predecessorId: string; successorId: string }> = [];
        for (const input of params.tasks as {
          title: string;
          brief: string;
          kind?: "implementation" | "investigation";
          tier: string;
          commitMessage?: string;
          supersedesTaskId?: string;
          dependsOn?: string[];
          writePaths?: string[];
          successCriteria?: string[];
          verificationProfile?: string;
          reviewPolicy?: "single" | "confirm" | "find-and-refute";
          discovery?: { allowedWritePaths: string[] };
        }[]) {
          const verificationProfile =
            input.verificationProfile ?? config.defaultVerificationProfile;
          if (verificationProfile && !config.verificationProfiles?.[verificationProfile]) {
            throw new Error(`Unknown verification profile: ${verificationProfile}`);
          }
          const { kind: inputKind, ...inputWithoutKind } = input;
          const contract = normalizeTaskContract({
            ...inputWithoutKind,
            ...(inputKind === "investigation" ? { kind: "investigation" as const } : {}),
          });
          let discovery: { allowedWritePaths: string[] } | undefined;
          if (input.discovery) {
            if (contract.writePaths.length !== 0) {
              throw new Error("Discovery tasks must use writePaths: []");
            }
            const allowedWritePaths = normalizeWritePaths(input.discovery.allowedWritePaths);
            if (allowedWritePaths.length === 0) {
              throw new Error("Discovery tasks require at least one allowed generated write scope");
            }
            discovery = { allowedWritePaths };
          }
          if (!config.tiers[input.tier]) {
            throw new Error(
              `Unknown tier "${input.tier}". Available tiers: ${Object.keys(config.tiers).join(", ")}`
            );
          }
          const taskInput: Parameters<typeof createTask>[1] = {
            title: input.title,
            brief: input.brief,
            tier: input.tier,
          };
          if (contract.kind) taskInput.kind = contract.kind;
          if (input.commitMessage) taskInput.commitMessage = input.commitMessage;
          if (input.dependsOn) taskInput.dependsOn = input.dependsOn;
          taskInput.writePaths = contract.writePaths;
          if (contract.successCriteria) taskInput.successCriteria = contract.successCriteria;
          if (discovery) taskInput.discovery = discovery;
          if (verificationProfile) taskInput.verificationProfile = verificationProfile;
          if (input.reviewPolicy) taskInput.reviewPolicy = input.reviewPolicy;
          const task = createTask(board, taskInput);
          created.push(task);

          if (input.supersedesTaskId) {
            const predecessorId = input.supersedesTaskId.trim().toUpperCase();
            if (supersededTaskIds.has(predecessorId)) {
              throw new Error(`${predecessorId} cannot be superseded more than once in one plan.`);
            }
            applyTaskSupersession(board, task, predecessorId);
            supersededTaskIds.add(predecessorId);
            supersessions.push({ predecessorId, successorId: task.id });
          }
        }
        const validationError = planValidationMessage(
          validatePlan(board, Object.keys(config.tiers))
        );
        if (validationError) throw new Error(validationError);

        // The plan gate protects the initial board. Once execution has started,
        // the orchestrator may add recovery/successor tasks without stopping the
        // drive for another human approval. Explicit recipe/discovery expansion
        // keeps its own mandatory approval gate.
        if (config.planGate && created.length > 0 && initialTaskCount === 0) {
          board.planPending = true;
        }
        if (preflightWorkflow(board, config).requiresConfirmation) board.planPending = true;
        return { created, supersessions, planPending: board.planPending };
      });
      const worktreeWarning = parkIdleToolWorktrees(ctx.cwd, driveController);
      adoptBoard(ctx);
      refreshUI(ctx);

      const { created, supersessions } = result;
      const lines = created.map((task) => `${task.id}: ${task.title} (${task.tier})`);
      const approval = result.planPending
        ? `\n\nPlan awaits user approval via /${COMMAND} plan. Do not start maestro_drive yet.`
        : "";
      const replacement = supersessions.length
        ? `\nSuperseded atomically: ${supersessions
            .map(({ predecessorId, successorId }) => `${predecessorId} → ${successorId}`)
            .join(", ")}. Downstream dependencies were rewired.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Created ${created.length} task(s):\n${lines.join("\n")}${replacement}${approval}${worktreeWarning}`,
          },
        ],
        details: { action: "plan", tasks: created.map((task) => snapshot(task)) },
      };
    },
    renderCall(args, theme) {
      const tasks = (args.tasks ?? []) as { title?: string; tier?: string }[];
      let text =
        theme.fg("toolTitle", theme.bold("maestro plan ")) +
        theme.fg("accent", `${tasks.length} task(s)`);
      for (const task of tasks.slice(0, 6)) {
        text += `\n  ${theme.fg("muted", "•")} ${task.title ?? "…"}${theme.fg("dim", ` [${task.tier ?? "?"}]`)}`;
      }
      if (tasks.length > 6) text += `\n  ${theme.fg("muted", `… +${tasks.length - 6} more`)}`;
      return new Text(text, 0, 0);
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_drive",
    label: "Maestro Drive",
    description:
      "Start or inspect a state-aware background drive, or intervene in live work. Routine progress stays in the dashboard; completion and decisions wake the orchestrator.",
    promptSnippet: "Drive mechanical run/review/retry cycles to completion (maestro board)",
    parameters: Type.Object({
      action: StringEnum(["start", "inspect", "intervene"] as const),
      taskIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional task scope. For start, drive these tasks; for inspect, show these tasks; for a live steer/abort, target these tasks. Omit for the whole board or all live tasks.",
        })
      ),
      intervention: Type.Optional(
        StringEnum(["steer", "abort", "handoff"] as const, {
          description:
            "Used only with action=intervene. Steer/abort target live executors. With decisionId, steer resumes after board fixes, abort settles the decision, and handoff transfers it.",
        })
      ),
      decisionId: Type.Optional(
        Type.String({
          description:
            "Settled decision to resolve with handoff or abort. After changing the board to address a decision, use action=start directly instead.",
        })
      ),
      instruction: Type.Optional(
        Type.String({
          maxLength: 1000,
          description: "Steering text for live executors. Ignored for handoff/abort compatibility.",
        })
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as Record<PropertyKey, unknown>;
      const input = args as Record<string, unknown>;
      const action = input.action;
      if (action === "drive" || action === "resume") return { ...input, action: "start" };
      if (action === "status") return { ...input, action: "inspect" };
      if (action === "steer" || action === "abort" || action === "handoff") {
        return { ...input, action: "intervene", intervention: action };
      }
      if (!("action" in input)) {
        return { ...input, action: input.intervention ? "intervene" : "start" };
      }
      return input;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as unknown as DriveToolInput;
      validateDriveToolInput(input);
      const board = loadBoard(ctx.cwd);
      const taskIds = canonicalTaskIds(board, input.taskIds);
      if (input.action === "inspect") {
        const selectedTasks = board.tasks.filter((task) => !taskIds || taskIds.includes(task.id));
        const tasks = selectedTasks.map((task) => snapshot(task));
        const selectedIds = new Set(selectedTasks.map((task) => task.id));
        const evidence = selectedTasks.map((task) => ({
          taskId: task.id,
          attempts: task.attempts.length,
          launches: task.attempts.reduce(
            (count, attempt) => count + 1 + (attempt.reviewLaunches?.length ?? 0),
            0
          ),
          failureReason: task.attempts.at(-1)?.failureReason
            ? {
                kind: task.attempts.at(-1)?.failureReason?.kind,
                message: truncateText(task.attempts.at(-1)?.failureReason?.message ?? "", 500),
              }
            : undefined,
          reviews: task.attempts.flatMap((attempt) =>
            (attempt.reviewLaunches ?? []).map((launch) => ({
              role: launch.role ?? "reviewer",
              verdict: launch.verdict ?? "pending",
            }))
          ),
          convergence: task.attempts.at(-1)?.reviewConvergence
            ? {
                policy: task.attempts.at(-1)?.reviewConvergence?.policy,
                status: task.attempts.at(-1)?.reviewConvergence?.status,
                summary: truncateText(task.attempts.at(-1)?.reviewConvergence?.summary ?? "", 500),
              }
            : undefined,
          reviewNotes: task.reviewNotes
            ? truncateText(task.reviewNotes, 500)
            : task.attempts.at(-1)?.reviewNotes
              ? truncateText(task.attempts.at(-1)?.reviewNotes ?? "", 500)
              : undefined,
        }));
        const selectedRuns = [...driveController.liveRunValues()].filter((run) =>
          selectedIds.has(run.taskId)
        );
        const live = selectedRuns.map((run) => `${run.taskId}: ${run.lastActivity}`).join("\n");
        const decision =
          board.activeDecision &&
          (!taskIds ||
            board.activeDecision.taskIds.length === 0 ||
            board.activeDecision.taskIds.some((id) => selectedIds.has(id)))
            ? board.activeDecision
            : undefined;
        const decisionText = decision
          ? `Decision ${decision.id} (${decision.kind}): ${decision.evidence}\n`
          : "";
        const projectedBoard = { ...board, tasks: selectedTasks };
        if (!decision) delete projectedBoard.activeDecision;
        const statusText = formatStatusProjection(
          projectStatus(
            projectedBoard,
            selectedRuns.map((run) => run.taskId),
            loadConfig(ctx.cwd),
            new Map(selectedRuns.map((run) => [run.taskId, run.kind] as const))
          )
        );
        return {
          content: [
            {
              type: "text",
              text: truncateText(
                `${decisionText}${statusText}\n${live || "No live executors."}\nReview evidence:\n${JSON.stringify(evidence)}`,
                4000
              ),
            },
          ],
          details: { action: "drive", tasks },
        };
      }
      if (input.action === "intervene") {
        const intervention = input.intervention;
        if (!intervention) throw new Error("intervention is required");
        if (input.decisionId) {
          const current = ctx.sessionManager.getSessionFile();
          const resolved = resolveDriveDecision(ctx.cwd, input.decisionId, current, intervention);
          if (intervention === "steer") {
            try {
              startBackgroundDrive(ctx, taskIds, signal);
            } catch (error) {
              updateBoard(ctx.cwd, (board) => {
                const decision = board.activeDecision;
                if (
                  decision?.id === resolved.id &&
                  decision.resolution?.resolvedAt === resolved.resolution?.resolvedAt
                ) {
                  delete decision.resolution;
                }
              });
              throw error;
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Decision ${resolved.id} addressed; drive resumed for ${taskIds?.join(", ") ?? "the whole board"}.`,
                },
              ],
              details: { action: "drive", tasks: [] },
            };
          }
          if (input.intervention === "handoff") {
            pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
          }
          return {
            content: [{ type: "text", text: `Decision ${resolved.id} resolved.` }],
            details: { action: "drive", tasks: [] },
          };
        }
        if (input.intervention === "handoff") {
          pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
        } else {
          const selectedRuns = [...driveController.liveRunValues()].filter(
            (run) => !taskIds || taskIds.includes(run.taskId)
          );
          if (selectedRuns.length === 0)
            throw new Error("No matching live executor to intervene in.");
          for (const run of selectedRuns) {
            if (input.intervention === "abort") run.handle.abort();
            else run.handle.steer(input.instruction as string);
          }
        }
        return {
          content: [{ type: "text", text: `${input.intervention} queued.` }],
          details: { action: "drive", tasks: [] },
        };
      }
      if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");
      startBackgroundDrive(ctx, taskIds, signal);
      return {
        content: [
          {
            type: "text",
            text: `Drive started for ${taskIds?.join(", ") ?? "the whole board"}. Wait for a completion or decision message.`,
          },
        ],
        details: {
          action: "drive",
          tasks: loadBoard(ctx.cwd)
            .tasks.filter((task) => !taskIds || taskIds.includes(task.id))
            .map((task) => snapshot(task)),
        },
      };
    },
    renderCall(args, theme) {
      const ids = args.taskIds as string[] | undefined;
      const scope = ids && ids.length > 0 ? ids.join(", ") : "whole board";
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro drive ")) + theme.fg("accent", scope),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });

  pi.registerTool<ReturnType<typeof Type.Object>, MaestroDetails>({
    name: "maestro_update",
    label: "Maestro Update",
    description:
      "Update a planned task: refine its contract, retitle it, cancel it, or reactivate it. Contract edits on running or ready-for-review tasks are rejected unless invalidateInFlight is true; cancellation remains allowed. Active dispatch ownership still prevents racing a live executor or reviewer.",
    promptSnippet: "Refine a task's brief/tier or cancel it (maestro board)",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id like T1" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      brief: Type.Optional(Type.String({ description: "New self-contained brief" })),
      kind: Type.Optional(
        StringEnum(["implementation", "investigation"] as const, {
          description:
            "Replacement task kind; investigation marks explicit read-only/no-file work and requires writePaths: [].",
        })
      ),
      tier: Type.Optional(Type.String({ description: "New complexity tier" })),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), { description: "Replacement dependency task ids" })
      ),
      writePaths: Type.Optional(
        Type.Array(Type.String(), { maxItems: 64, description: "Replacement write scope" })
      ),
      successCriteria: Type.Optional(
        Type.Array(Type.String({ maxLength: 500 }), {
          minItems: 1,
          maxItems: 12,
          description: "Replacement observable success criteria",
        })
      ),
      verificationProfile: Type.Optional(
        Type.String({ description: "Replacement trusted verification profile; empty clears it" })
      ),
      commitMessage: Type.Optional(
        Type.String({ description: "Replacement conventional commit message; empty clears it" })
      ),
      reviewPolicy: Type.Optional(
        StringEnum(["single", "confirm", "find-and-refute"] as const, {
          description: "Replacement review convergence policy",
        })
      ),
      supersedesTaskId: Type.Optional(
        Type.String({
          description:
            "Stopped predecessor this existing task replaces. Atomically cancel it and rewire all downstream dependencies to taskId.",
        })
      ),
      invalidateInFlight: Type.Optional(
        Type.Boolean({
          description:
            "Acknowledge that contract edits to a running or ready-for-review task invalidate its current attempt/review and cost.",
        })
      ),
      cancel: Type.Optional(
        Type.Boolean({ description: "Set true to cancel, or false to reactivate a cancelled task" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        taskId,
        title,
        brief,
        kind,
        tier,
        dependsOn,
        writePaths,
        successCriteria,
        verificationProfile,
        commitMessage,
        reviewPolicy,
        supersedesTaskId,
        invalidateInFlight,
        cancel,
      } = params as {
        taskId: string;
        title?: string;
        brief?: string;
        kind?: "implementation" | "investigation";
        tier?: string;
        dependsOn?: string[];
        writePaths?: string[];
        successCriteria?: string[];
        verificationProfile?: string;
        commitMessage?: string;
        reviewPolicy?: "single" | "confirm" | "find-and-refute";
        supersedesTaskId?: string;
        invalidateInFlight?: boolean;
        cancel?: boolean;
      };
      const config = loadConfig(ctx.cwd);
      if (
        verificationProfile?.trim() &&
        !config.verificationProfiles?.[verificationProfile.trim()]
      ) {
        throw new Error(`Unknown verification profile: ${verificationProfile}`);
      }
      if (driveController.isTaskLive(taskId.trim().toUpperCase())) {
        throw new Error(`${taskId} is running. Abort it first or wait for it to finish.`);
      }
      const beforeTask = findTask(loadBoard(ctx.cwd), taskId);
      const wasInFlight =
        beforeTask?.status === "running" || beforeTask?.status === "ready_for_review";
      const editsContractField =
        title !== undefined ||
        brief !== undefined ||
        kind !== undefined ||
        successCriteria !== undefined ||
        tier !== undefined ||
        writePaths !== undefined ||
        verificationProfile !== undefined ||
        reviewPolicy !== undefined ||
        dependsOn !== undefined ||
        commitMessage !== undefined;
      const editsTaskContract =
        brief !== undefined ||
        kind !== undefined ||
        writePaths !== undefined ||
        successCriteria !== undefined;
      const costSoFar = beforeTask ? snapshot(beforeTask).cost : 0;
      if (wasInFlight && editsContractField && !invalidateInFlight) {
        throw new Error(
          `${beforeTask.id} is ${beforeTask.status} with an in-flight attempt/review ($${costSoFar.toFixed(4)} cost so far). This contract edit would invalidate that work. Wait for it to settle or pass invalidateInFlight: true to acknowledge the invalidation.`
        );
      }
      const updated = updateTask(ctx.cwd, taskId, (fresh, board) => {
        assertPlanTaskLimit(board.tasks.length, config);
        assertTaskNotDispatched(fresh);
        applyPlanTaskEdits(
          fresh,
          {
            ...(title !== undefined ? { title } : {}),
            ...(brief !== undefined ? { brief } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(tier !== undefined ? { tier } : {}),
            ...(dependsOn !== undefined ? { dependsOn } : {}),
            ...(writePaths !== undefined ? { writePaths } : {}),
            ...(successCriteria !== undefined ? { successCriteria } : {}),
            ...(verificationProfile !== undefined ? { verificationProfile } : {}),
            ...(commitMessage !== undefined ? { commitMessage } : {}),
            ...(reviewPolicy !== undefined ? { reviewPolicy } : {}),
            ...(cancel !== undefined ? { cancelled: cancel } : {}),
          },
          Object.keys(config.tiers)
        );
        if (editsTaskContract) {
          const contract = normalizeExistingTaskContract(fresh);
          fresh.writePaths = contract.writePaths;
          if (contract.successCriteria) fresh.successCriteria = contract.successCriteria;
          else delete fresh.successCriteria;
        }
        if (supersedesTaskId) applyTaskSupersession(board, fresh, supersedesTaskId);
        const validationError = planValidationMessage(
          validatePlan(board, Object.keys(config.tiers))
        );
        if (validationError) throw new Error(validationError);
      });
      if (!updated) throw new Error(`Unknown task: ${taskId}`);
      const worktreeWarning = parkIdleToolWorktrees(ctx.cwd, driveController);
      refreshUI(ctx);
      const text = `${
        wasInFlight && editsContractField
          ? `Updated: ${taskLine(updated)}\nWarning: $${costSoFar.toFixed(4)} of in-flight attempt/review cost was invalidated with invalidateInFlight: true; ${updated.id} needs re-execution under the new contract.`
          : `Updated: ${taskLine(updated)}`
      }${worktreeWarning}`;
      return {
        content: [{ type: "text", text }],
        details: { action: "update", tasks: [snapshot(updated)] },
      };
    },
    renderCall(args, theme) {
      const changes = [
        args.title ? "title" : null,
        args.brief ? "brief" : null,
        args.tier ? `tier→${args.tier}` : null,
        args.dependsOn ? "dependencies" : null,
        args.commitMessage !== undefined ? "commit message" : null,
        args.supersedesTaskId ? `supersedes ${args.supersedesTaskId}` : null,
        args.cancel === true ? "cancel" : null,
        args.cancel === false ? "reactivate" : null,
      ]
        .filter((part) => part !== null)
        .join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("maestro update ")) +
          theme.fg("accent", `${args.taskId} (${changes || "no changes"})`),
        0,
        0
      );
    },
    renderResult: renderTaskListResult,
  });
}

function parkIdleToolWorktrees(cwd: string, driveController: DriveRuntimeController): string {
  const liveTaskIds = new Set([...driveController.liveRunValues()].map((run) => run.taskId));
  const parking = parkInactiveWorktrees(cwd, loadBoard(cwd), liveTaskIds);
  return parking.warnings.length > 0
    ? `\nWarning: Some idle worktrees could not be cleaned: ${parking.warnings.join("; ")}`
    : "";
}

function applyTaskSupersession(
  board: ReturnType<typeof loadBoard>,
  successor: Task,
  predecessorId: string
): void {
  const predecessor = findTask(board, predecessorId);
  if (!predecessor || predecessor === successor) {
    throw new Error(`Unknown predecessor: ${predecessorId}`);
  }
  if (
    predecessor.status !== "failed" &&
    predecessor.status !== "cancelled" &&
    predecessor.status !== "changes_requested"
  ) {
    throw new Error(
      `${predecessor.id} cannot be superseded while ${predecessor.status}; only failed, cancelled, or changes-requested tasks can be replaced.`
    );
  }
  if (
    successor.dependsOn.some(
      (dependencyId) => dependencyId.toUpperCase() === predecessor.id.toUpperCase()
    )
  ) {
    throw new Error(`${successor.id} cannot depend on the predecessor it supersedes.`);
  }

  predecessor.supersededBy = successor.id;
  successor.supersedes = predecessor.id;
  forceStatus(predecessor, "cancelled");
  for (const dependent of board.tasks) {
    if (dependent === successor) continue;
    dependent.dependsOn = [
      ...new Set(
        dependent.dependsOn.map((dependencyId) =>
          dependencyId.toUpperCase() === predecessor.id.toUpperCase() ? successor.id : dependencyId
        )
      ),
    ];
  }
}

function renderTaskListResult(
  result: { content: { type: string; text?: string }[]; details?: MaestroDetails },
  { expanded }: { expanded: boolean },
  theme: Theme
) {
  const details = result.details;
  if (!details || details.tasks.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
  }

  const statusColor = (
    status: TaskStatus
  ): "success" | "error" | "warning" | "accent" | "muted" => {
    if (status === "approved") return "success";
    if (status === "failed" || status === "cancelled") return "error";
    if (status === "running" || status === "changes_requested") return "warning";
    if (status === "ready_for_review") return "accent";
    return "muted";
  };

  let text = "";
  for (const snap of details.tasks) {
    const glyph = theme.fg(statusColor(snap.status), STATUS_GLYPHS[snap.status]);
    const cost = snap.cost
      ? theme.fg("dim", ` · ${snap.turns} turns · $${snap.cost.toFixed(4)}`)
      : "";
    text += `${glyph} ${theme.fg("accent", snap.id)} ${snap.title} ${theme.fg(statusColor(snap.status), STATUS_LABELS[snap.status])}${theme.fg("dim", ` [${snap.tier}]`)}${cost}\n`;
    if (
      snap.note &&
      (expanded || snap.status === "failed" || snap.status === "changes_requested")
    ) {
      const note = expanded ? snap.note : truncateText(snap.note, 3);
      text += `${theme.fg("dim", note.replace(/^/gm, "    "))}\n`;
    }
  }
  if (details.stoppedBecause) {
    const summary = formatDriveSummary({
      rounds: details.rounds ?? 0,
      tasks: details.tasks,
      stoppedBecause: details.stoppedBecause,
    });
    text += `\n${theme.fg("dim", summary)}\n`;
  }
  return new Text(text.trimEnd(), 0, 0);
}

// ------------------------------------------------------------- commands

export interface DriveToolInput {
  action: "start" | "inspect" | "intervene";
  taskIds?: string[];
  intervention?: "steer" | "abort" | "handoff";
  decisionId?: string;
  instruction?: string;
}

export function validateDriveToolInput(input: DriveToolInput): void {
  if (input.action === "inspect") {
    if (input.intervention || input.instruction || input.decisionId) {
      throw new Error("inspect does not accept intervention, decisionId, or instruction");
    }
    return;
  }
  if (input.action === "start") {
    if (input.intervention || input.instruction || input.decisionId) {
      throw new Error("start does not accept intervention, decisionId, or instruction");
    }
    return;
  }
  if (!input.intervention) throw new Error("intervention is required");
  if (input.intervention === "steer" && !input.instruction?.trim()) {
    throw new Error("steer requires an instruction");
  }
}

import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPlanTaskEdits, createTask, loadBoard, saveBoard, updateTask } from "./board.js";
import { loadConfig } from "./config.js";
import { COMMAND } from "./constants.js";
import { type BackgroundDrive, type DriveRuntimeController } from "./drive-controller.js";
import { STATUS_GLYPHS, STATUS_LABELS, taskLine, truncateText } from "./format.js";
import { assertKnownTaskIds } from "./session-control.js";
import { formatStatusProjection, projectStatus } from "./status.js";
import { type Task, type TaskStatus } from "./types.js";
import {
  type DriveSummary,
  formatDriveSummary,
  snapshot,
  type TaskSnapshot,
  type WorkflowRun,
} from "./workflow.js";

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
  liveRuns: Map<string, WorkflowRun>;
  driveController: DriveRuntimeController;
  startBackgroundDrive(
    ctx: ExtensionContext,
    taskIds: string[] | undefined,
    signal?: AbortSignal
  ): BackgroundDrive;
}

export function registerMaestroTools(runtime: ModelToolRuntime): void {
  const { pi, adoptBoard, refreshUI, liveRuns, driveController, startBackgroundDrive } = runtime;
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
          tier: Type.String({ description: "Complexity tier: trivial, standard, or complex" }),
          writePaths: Type.Array(Type.String(), {
            maxItems: 64,
            description:
              "Repository-relative files or directory/** scopes this task may change. Use [] only for explicit investigation/no-file work.",
          }),
          successCriteria: Type.Array(Type.String({ maxLength: 500 }), {
            minItems: 1,
            maxItems: 12,
            description: "Explicit observable outcomes the executor and reviewer must verify.",
          }),
          verificationProfile: Type.Optional(
            Type.String({ description: "Trusted configured verification profile name" })
          ),
          commitMessage: Type.Optional(
            Type.String({
              description:
                "Conventional commit message (e.g. 'fix: handle empty board') used when this task's approved work is committed. Defaults to 'feat: <title>'.",
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
      adoptBoard(ctx);
      const config = loadConfig(ctx.cwd);
      const board = loadBoard(ctx.cwd);
      const initialTaskCount = board.tasks.length;
      const created: Task[] = [];
      for (const input of params.tasks as {
        title: string;
        brief: string;
        tier: string;
        commitMessage?: string;
        dependsOn?: string[];
        writePaths?: string[];
        successCriteria?: string[];
        verificationProfile?: string;
      }[]) {
        const verificationProfile = input.verificationProfile ?? config.defaultVerificationProfile;
        if (verificationProfile && !config.verificationProfiles?.[verificationProfile]) {
          throw new Error(`Unknown verification profile: ${verificationProfile}`);
        }
        if (!input.writePaths) throw new Error("writePaths is required for every new task");
        const noFileTask =
          input.writePaths.length === 0 && /investigat|no[- ]file|read[- ]only/i.test(input.brief);
        if (!noFileTask && !input.successCriteria) {
          throw new Error("successCriteria is required for every executable task");
        }
        if (
          input.writePaths.length === 0 &&
          !/investigat|no[- ]file|read[- ]only/i.test(input.brief)
        ) {
          throw new Error("Empty writePaths requires an explicit investigation or no-file brief");
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
        if (input.commitMessage) taskInput.commitMessage = input.commitMessage;
        if (input.dependsOn) taskInput.dependsOn = input.dependsOn;
        taskInput.writePaths = input.writePaths;
        if (input.successCriteria) taskInput.successCriteria = input.successCriteria;
        if (verificationProfile) taskInput.verificationProfile = verificationProfile;
        created.push(createTask(board, taskInput));
      }
      // The plan gate protects the initial board. Once execution has started,
      // the orchestrator may add recovery/successor tasks without stopping the
      // drive for another human approval. Explicit recipe/discovery expansion
      // keeps its own mandatory approval gate.
      if (config.planGate && created.length > 0 && initialTaskCount === 0) {
        board.planPending = true;
      }
      saveBoard(ctx.cwd, board);
      refreshUI(ctx);

      const lines = created.map((task) => `${task.id}: ${task.title} (${task.tier})`);
      const approval = board.planPending
        ? `\n\nPlan awaits user approval via /${COMMAND} plan. Do not start maestro_drive yet.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Created ${created.length} task(s):\n${lines.join("\n")}${approval}`,
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
          description: "Specific task ids to drive. Omit to drive the whole board.",
        })
      ),
      intervention: Type.Optional(StringEnum(["steer", "abort", "handoff"] as const)),
      decisionId: Type.Optional(Type.String({ description: "Active settled decision to resolve" })),
      instruction: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    prepareArguments(args) {
      if (args && typeof args === "object" && !("action" in args))
        return { ...args, action: "start" };
      return args as Record<PropertyKey, unknown>;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as unknown as DriveToolInput;
      validateDriveToolInput(input);
      if (input.action === "inspect") {
        const board = loadBoard(ctx.cwd);
        const tasks = board.tasks.map((task) => snapshot(task));
        const live = [...liveRuns.values()]
          .map((run) => `${run.taskId}: ${run.lastActivity}`)
          .join("\n");
        const decision = board.activeDecision;
        const decisionText = decision
          ? `\nDecision ${decision.id} (${decision.kind}): ${decision.evidence}`
          : "";
        const statusText = formatStatusProjection(projectStatus(board, liveRuns.keys()));
        return {
          content: [
            {
              type: "text",
              text: truncateText(
                `${statusText}\n${live || "No live executors."}${decisionText}`,
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
          const board = loadBoard(ctx.cwd);
          const decision = board.activeDecision;
          if (!decision || decision.id !== input.decisionId || decision.resolution) {
            throw new Error("Decision is stale or already resolved");
          }
          const current = ctx.sessionManager.getSessionFile();
          if (decision.ownerSession && current && decision.ownerSession !== current) {
            throw new Error("Only the decision owner may resolve it");
          }
          if (!decision.allowedInterventions.includes(intervention)) {
            throw new Error(`${intervention} is not allowed for this decision`);
          }
          decision.resolution = { intervention, resolvedAt: Date.now() };
          saveBoard(ctx.cwd, board);
          if (input.intervention === "handoff") {
            pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
          }
          return {
            content: [{ type: "text", text: `Decision ${decision.id} resolved.` }],
            details: { action: "drive", tasks: [] },
          };
        }
        if (input.intervention === "handoff") {
          pi.sendUserMessage(`/${COMMAND} handoff`, { deliverAs: "followUp" });
        } else {
          if (liveRuns.size === 0) throw new Error("No live executor to intervene in.");
          for (const run of liveRuns.values()) {
            if (input.intervention === "abort") run.handle.abort();
            else
              run.handle.steer(
                input.instruction ?? "Report the concrete blocker or finish the scoped task."
              );
          }
        }
        return {
          content: [{ type: "text", text: `${input.intervention} queued.` }],
          details: { action: "drive", tasks: [] },
        };
      }
      const taskIds = input.taskIds;
      if (driveController.hasActive()) throw new Error("An autonomous drive is already active.");
      assertKnownTaskIds(loadBoard(ctx.cwd), taskIds);
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
      "Update a planned task: refine its brief, retitle it, change its tier or dependencies, cancel it, or reactivate it. Use when a task failed twice with the same root cause or the plan needs adjusting. Running tasks cannot be updated.",
    promptSnippet: "Refine a task's brief/tier or cancel it (maestro board)",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task id like T1" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      brief: Type.Optional(Type.String({ description: "New self-contained brief" })),
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
      cancel: Type.Optional(
        Type.Boolean({ description: "Set true to cancel, or false to reactivate a cancelled task" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        taskId,
        title,
        brief,
        tier,
        dependsOn,
        writePaths,
        successCriteria,
        verificationProfile,
        cancel,
      } = params as {
        taskId: string;
        title?: string;
        brief?: string;
        tier?: string;
        dependsOn?: string[];
        writePaths?: string[];
        successCriteria?: string[];
        verificationProfile?: string;
        cancel?: boolean;
      };
      const config = loadConfig(ctx.cwd);
      if (
        verificationProfile?.trim() &&
        !config.verificationProfiles?.[verificationProfile.trim()]
      ) {
        throw new Error(`Unknown verification profile: ${verificationProfile}`);
      }
      if (liveRuns.has(taskId.trim().toUpperCase())) {
        throw new Error(`${taskId} is running. Abort it first or wait for it to finish.`);
      }
      const updated = updateTask(ctx.cwd, taskId, (fresh) => {
        applyPlanTaskEdits(
          fresh,
          {
            ...(title !== undefined ? { title } : {}),
            ...(brief !== undefined ? { brief } : {}),
            ...(tier !== undefined ? { tier } : {}),
            ...(dependsOn !== undefined ? { dependsOn } : {}),
            ...(writePaths !== undefined ? { writePaths } : {}),
            ...(successCriteria !== undefined ? { successCriteria } : {}),
            ...(verificationProfile !== undefined ? { verificationProfile } : {}),
            ...(cancel !== undefined ? { cancelled: cancel } : {}),
          },
          Object.keys(config.tiers)
        );
      });
      if (!updated) throw new Error(`Unknown task: ${taskId}`);
      refreshUI(ctx);
      return {
        content: [{ type: "text", text: `Updated: ${taskLine(updated)}` }],
        details: { action: "update", tasks: [snapshot(updated)] },
      };
    },
    renderCall(args, theme) {
      const changes = [
        args.title ? "title" : null,
        args.brief ? "brief" : null,
        args.tier ? `tier→${args.tier}` : null,
        args.dependsOn ? "dependencies" : null,
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
    if (input.taskIds || input.intervention || input.instruction || input.decisionId) {
      throw new Error("inspect does not accept taskIds, intervention, decisionId, or instruction");
    }
    return;
  }
  if (input.action === "start") {
    if (input.intervention || input.instruction || input.decisionId) {
      throw new Error("start does not accept intervention, decisionId, or instruction");
    }
    return;
  }
  if (input.taskIds) throw new Error("intervene does not accept taskIds");
  if (!input.intervention) throw new Error("intervention is required");
  if (input.intervention !== "steer" && input.instruction) {
    throw new Error("instruction is only valid for steer");
  }
  if (input.intervention === "steer" && !input.instruction?.trim()) {
    throw new Error("steer requires an instruction");
  }
}

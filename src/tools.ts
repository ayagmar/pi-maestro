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

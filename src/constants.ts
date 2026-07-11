export const EXTENSION_NAME = "pi-maestro";
export const COMMAND = "maestro";
export const MESSAGE_TYPE = "maestro";
export const STATE_ENTRY_TYPE = "maestro:event";

/** All maestro state lives under this directory, relative to the project cwd. */
export const STATE_DIR = ".pi/maestro";
export const LOGS_DIR = "logs";

export const PROJECT_CONFIG_FILE = ".pi/maestro.json";
export const USER_CONFIG_FILE = "maestro.json";

export const KILL_GRACE_MS = 5000;
export const REPORT_PREVIEW_LINES = 40;

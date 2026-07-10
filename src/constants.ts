export const EXTENSION_NAME = "pi-conductor";
export const COMMAND = "conductor";
export const MESSAGE_TYPE = "conductor";
export const STATE_ENTRY_TYPE = "conductor:event";

/** All conductor state lives under this directory, relative to the project cwd. */
export const STATE_DIR = ".pi/conductor";
export const BOARD_FILE = "board.json";
export const SESSIONS_DIR = "sessions";
export const LOGS_DIR = "logs";

export const PROJECT_CONFIG_FILE = ".pi/conductor.json";
export const USER_CONFIG_FILE = "conductor.json";

export const KILL_GRACE_MS = 5000;
export const REPORT_PREVIEW_LINES = 40;

export interface PolicyEvent {
  type: string;
  command?: string;
}

export interface PolicyMessage {
  content?: Array<{ type: string; text?: string }>;
}

export declare const EXIT_SETTLE_DRAIN_MS: number;
export declare const WATCHDOG_STEER_MESSAGES: Record<
  "implementation" | "investigation" | "review",
  string
>;

export declare function compactEvent(event: PolicyEvent): boolean;
export declare function extractText(message: PolicyMessage | undefined): string;
export declare function boundedText(report: string, maxChars: number): string;
export declare function boundedBytes(report: string, maxBytes: number): string;

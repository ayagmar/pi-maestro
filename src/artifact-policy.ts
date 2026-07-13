import { truncateText } from "./format.js";
import { type Attempt, type Task } from "./types.js";

function pathInWriteScope(path: string, writePaths: string[]): boolean {
  return writePaths.some((scope) =>
    scope.endsWith("/**") ? path.startsWith(scope.slice(0, -2)) : path === scope
  );
}

export function artifactFindings(task: Task, attempt: Attempt): Task["findings"] {
  const findings: NonNullable<Task["findings"]> = [];
  const add = (fingerprint: string, message: string) => {
    findings.push({
      fingerprint,
      message: truncateText(message, 500),
      status: "open",
      firstAttempt: attempt.index,
      lastAttempt: attempt.index,
    });
  };
  const diff = attempt.diff ?? "";
  const paths = attempt.touchedFiles;

  if (task.writePaths) {
    const outside = paths.filter((path) => !pathInWriteScope(path, task.writePaths ?? []));
    if (outside.length > 0) {
      add("scope-violation", `Changed paths outside writePaths: ${outside.join(", ")}`);
    }
    if (task.writePaths.length > 0 && paths.length === 0) {
      add("empty-artifact", "Expected file work produced no attributable Git changes.");
    }
  }
  const deletedTests = paths.some(
    (path) => /(^|\/)(test|tests)(\/|\.|$)/.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path)
  );
  if (/deleted file mode/.test(diff) && deletedTests && !/delete|remove/i.test(task.brief)) {
    add("deleted-tests", "Existing tests were deleted without explicit task scope.");
  }
  if (/^[+-].*(testMatch|testRegex|include|exclude).*(narrow|ignore|exclude)/im.test(diff)) {
    add("test-discovery", "Test discovery or configuration appears narrowed.");
  }
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(diff)) {
    add("conflict-markers", "Unresolved merge conflict markers remain in the artifact.");
  }
  return findings;
}

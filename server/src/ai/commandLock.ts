/**
 * Serialize agent-issued shell commands per project. Parallel tasks may read,
 * plan and edit disjoint files concurrently, but two formatters/tests/codegen
 * commands must not mutate the same working tree at the same time.
 */
const projectLocks = new Map<string, Promise<void>>();

export function withCommandLock<T>(
  projectId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const run = previous.then(task, task);
  projectLocks.set(
    projectId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

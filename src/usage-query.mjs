// Index each immutable task once; no repeated prompt concatenation per request.
const searchIndexes = new WeakMap();
export function selectUsageDetails(usage, { taskDetail = "full", taskId = "", query = "",
  taskOffset = 0, taskLimit = 0, turnOffset = 0, turnLimit = 0, revision = "" } = {}) {
  if (!Array.isArray(usage?.tasks)) return usage;
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let tasks = usage.tasks.filter(task => {
    if (taskId) return task.id === taskId;
    if (!terms.length) return true;
    let indexed = searchIndexes.get(task);
    if (!indexed) {
      indexed = [task.id, task.label, task.title, ...(task.turns || []).map(t => t.prompt || "")].join(" ").toLocaleLowerCase();
      searchIndexes.set(task, indexed);
    }
    return terms.every(term => indexed.includes(term));
  });
  const taskTotal = tasks.length;
  const turnTotal = tasks.reduce((sum, task) => sum + (task.turnCount ?? task.turns?.length ?? 0), 0);
  const bounded = (value, max) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
  taskOffset = bounded(taskOffset, taskTotal); taskLimit = bounded(taskLimit, 500);
  turnOffset = bounded(turnOffset, 1000000); turnLimit = bounded(turnLimit, 500);
  if (!taskId) tasks = tasks.slice(taskOffset, taskLimit ? taskOffset + taskLimit : undefined);
  if (taskId && revision && tasks[0]?.revision !== revision) return { ...usage, tasks: [], revisionMismatch: true };
  if (taskDetail === "summary" && !taskId) {
    tasks = tasks.map(({ turns = [], ...task }) => ({ ...task, turnCount: task.turnCount ?? turns.length }));
  } else if (turnLimit || turnOffset) {
    tasks = tasks.map(task => ({ ...task, turnCount: task.turnCount ?? task.turns.length,
      turns: task.turns.slice(turnOffset, turnLimit ? turnOffset + turnLimit : undefined), turnOffset }));
  }
  return { ...usage, tasks, taskTotal, turnTotal, taskOffset };
}

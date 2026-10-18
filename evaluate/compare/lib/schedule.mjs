export const SIX_ARM_ORDERS = Object.freeze([
  [0, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1], [1, 0, 2], [2, 1, 0],
]);

export const TWO_ARM_ORDERS = Object.freeze([
  [0, 1], [1, 0],
]);

/** Deterministic balanced order across matched task repetitions. */
export function buildSchedule(tasks, armIds, repetitions = 1) {
  if (![1, 2, 3].includes(armIds.length)) throw new Error("comparison schedule requires one, two or three arms");
  if (new Set(armIds).size !== armIds.length) throw new Error("comparison schedule arm IDs must be unique");
  if (typeof repetitions === "number" && (!Number.isInteger(repetitions) || repetitions < 1)) throw new Error("repetitions must be a positive integer");
  // Rotate first position every matched group, including filtered task selections.
  const orders = armIds.length === 1 ? [[0]] : armIds.length === 2 ? TWO_ARM_ORDERS : SIX_ARM_ORDERS;
  let group = 0;
  return tasks.flatMap((task, taskIndex) => {
    const count = task.repetitions ?? (typeof repetitions === "object" ? repetitions[task.id] ?? repetitions[task.heavy ? "heavy" : task.type] ?? repetitions.default ?? 1 : repetitions);
    if (!Number.isInteger(count) || count < 1) throw new Error(`invalid repetitions for ${task.id}`);
    return Array.from({ length: count }, (_, repetitionIndex) => {
      const permutation = orders[group++ % orders.length];
      return permutation.map((armIndex, orderIndex) => ({
        runId: `${String(taskIndex + 1).padStart(2, "0")}-${task.id}${count > 1 ? `-r${String(repetitionIndex + 1).padStart(2, "0")}` : ""}-${armIds[armIndex]}`,
        taskIndex,
        repetition: repetitionIndex + 1,
        orderIndex,
        task,
        armId: armIds[armIndex],
      }));
    }).flat();
  });
}

import type { Suite, Task, VitestRunner } from "@vitest/runner";
import { VitestTestRunner } from "vitest/runners";

/** Drain actual controller acknowledgements before more synchronous fixture work. */
export default class AcknowledgedRunner extends VitestTestRunner {
  private readonly pending = new Set<Promise<void>>();
  private tracking = false;

  onBeforeRunFiles(): void {
    if (this.tracking) return;
    this.tracking = true;
    // Vitest installs its transport on the public runner hook before this call.
    const runner: VitestRunner = this;
    const send = runner.onTaskUpdate;
    if (!send) throw new Error("Vitest task-update transport is unavailable");
    runner.onTaskUpdate = (...args) => {
      const update = send.apply(this, args);
      this.pending.add(update);
      // Keep rejected updates: the barrier must surface the original error.
      void update.then(() => this.pending.delete(update), () => {});
      return update;
    };
  }

  private async drainUpdates(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  override async onBeforeRunTask(test: Task): Promise<void> {
    await this.drainUpdates();
    await super.onBeforeRunTask(test);
  }

  override async onAfterRunTask(test: Task): Promise<void> {
    super.onAfterRunTask(test);
    await this.drainUpdates();
  }

  override async onBeforeRunSuite(suite: Suite): Promise<void> {
    await this.drainUpdates();
    await super.onBeforeRunSuite(suite);
  }

  override async onAfterRunSuite(suite: Suite): Promise<void> {
    await super.onAfterRunSuite(suite);
    await this.drainUpdates();
  }
}

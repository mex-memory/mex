import { MachineSetupRepoIdSchema, type MachineRepoSetup, type MachineSetupSnapshot } from "@mex/hub-contracts/machine";
import { openHooksReadOnly, openRecordReadOnly } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { ControlSnapshot } from "./control-snapshot.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";
import { readRepoSetup, readSetupIndex } from "./setup-snapshot.js";

const DETAIL_LIMIT = 8;
const unavailable = "Setup couldn’t be read. Try again or run mex doctor.";

export function setupRepoId(value: string): string {
  const parsed = MachineSetupRepoIdSchema.safeParse(value);
  if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid repo", "Choose a repo from Setup.");
  return parsed.data;
}

/** Samples stored facts in the Hub worker. Quote preparation is separate from reads. */
export class SetupData {
  #index: ControlSnapshot<MachineSetupSnapshot>;
  #details = new Map<string, ControlSnapshot<MachineSetupSnapshot>>();
  #retiredVersion = 0;

  constructor(private readonly location: LocationOptions, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {
    this.#index = this.#snapshot();
  }

  get version() {
    return this.#retiredVersion + this.#index.version + [...this.#details.values()].reduce((total, snapshot) => total + snapshot.version, 0);
  }

  get(repoId?: string) {
    if (repoId === undefined) return this.#index.get();
    const id = setupRepoId(repoId);
    let snapshot = this.#details.get(id);
    if (snapshot) this.#details.delete(id);
    else if (this.#details.size >= DETAIL_LIMIT) {
      const [oldId, old] = this.#details.entries().next().value!;
      this.#retiredVersion += old.version + 1;
      old.close();
      this.#details.delete(oldId);
    }
    snapshot ??= this.#snapshot(id);
    this.#details.set(id, snapshot);
    return snapshot.get();
  }

  touch() {
    this.#index.touch();
    for (const detail of this.#details.values()) detail.touch();
  }

  change(repoId: string, edit: (repo: MachineRepoSetup) => MachineRepoSetup) {
    this.#index.refresh();
    const detail = this.#details.get(repoId);
    detail?.update(data => data.repo ? { ...data, repo: edit(data.repo) } : data);
    detail?.refresh();
  }

  close() {
    this.#index.close();
    for (const detail of this.#details.values()) detail.close();
  }

  #snapshot(repoId?: string) {
    return new ControlSnapshot<MachineSetupSnapshot>(this.now, async () => {
      const location = recordLocation({ ...this.location, create: false });
      return readStore(openRecordReadOnly, this.location, reader => readStore(openHooksReadOnly, this.location, hooks => repoId
        ? { repo: readRepoSetup(reader, hooks, location, repoId, this.now(), this.env) }
        : { repos: readSetupIndex(reader, hooks, location, this.now()) }));
    }, unavailable);
  }
}

import { externalHelper } from "external-lib";

export interface ProcessorOptions {
  timeout: number;
}

export type Status = "idle" | "running";

export enum ErrorCode {
  Timeout = 1,
  Unknown = 2,
}

export class Processor {
  private status: Status = "idle";
  protected options: ProcessorOptions;
  public id: string;

  constructor(options: ProcessorOptions) {
    this.options = options;
    this.id = "proc";
  }

  public async run(): Promise<void> {
    this.status = "running";
    const callback = () => {
      externalHelper(this.id);
    };
    callback();
  }
}

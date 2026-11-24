/// <reference types="vite/client" />

declare const __MEX_HUB_VERSION__: string;

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_WEB3FORMS_ACCESS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:mex-hub-fixture-api" {
  import type { FixtureApiOptions, HubApi } from "./api/client";

  export const createFixtureApi: ((options?: FixtureApiOptions) => HubApi) | null;
}

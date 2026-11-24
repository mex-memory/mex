import { z } from "zod";

const hubModeSchema = z.enum(["background", "terminal"]);
const versionSchema = z.string().min(1);

export const MachineHelloSchema = z.object({
  app: z.literal("mex-hub"),
  version: versionSchema,
  homeId: z.string().min(1),
  mode: hubModeSchema,
});

export const MachineBootstrapSchema = z.object({
  csrfToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export const MachineSessionSchema = MachineBootstrapSchema.extend({
  version: versionSchema,
  mode: hubModeSchema,
});

const checkoutSchema = z.object({
  path: z.string().min(1),
  state: z.enum(["on", "off", "off until"]),
  offUntil: z.string().nullable(),
  exists: z.boolean(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["git", "folder"]),
  shared: z.boolean(),
  provisional: z.enum(["unborn", "shallow"]).nullable(),
  checkouts: z.array(checkoutSchema),
});

export const MachineProjectsSchema = z.object({ projects: z.array(projectSchema) });

export const MachineProblemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  requestId: z.string(),
});

export type MachineSession = z.infer<typeof MachineSessionSchema>;
export type MachineProject = z.infer<typeof projectSchema>;
export type MachineCheckout = z.infer<typeof checkoutSchema>;
export type MachineProblem = z.infer<typeof MachineProblemSchema>;

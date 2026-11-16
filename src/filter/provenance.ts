import { z } from "zod";
export const sourceSchema = z.object({ session: z.string().max(512).nullable(), row: z.number().int().positive().safe().nullable(),
  at: z.string().max(64), marks: z.enum(["", "pasted", "scripted", "pasted,scripted"]), delivered: z.array(z.string().max(512)).max(128),
  note_id: z.string().regex(/^mx_[a-z0-9]{6,64}$/u).optional(), note_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(), private_tag: z.boolean().optional(), message_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional() }).strict();

import { z } from "zod";

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  surname: z.string().trim().min(1).max(80).optional(),
  birthDate: z.iso.date().transform((date) => new Date(`${date}T00:00:00.000Z`)).optional()
}).strict().refine((data) => Object.keys(data).length > 0, {
  message: "At least one profile field must be provided"
});

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
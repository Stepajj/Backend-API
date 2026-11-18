import { z } from "zod";

export const registrationSchema = z.object({
  email: z.email().max(254).transform(email => email.trim().toLowerCase()),
  password: z.string().min(8).max(128)
}).strict();

export type RegistrationInput = z.infer<typeof registrationSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).transform(email => email.trim().toLowerCase()),
  password: z.string().min(1).max(128)
}).strict();

export type LoginInput = z.infer<typeof loginSchema>;

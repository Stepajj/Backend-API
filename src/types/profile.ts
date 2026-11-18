import type { User } from "./user.js";

export type ProfileUpdateData = Partial<
  Pick<User, "name" | "surname" | "birthDate">
>;

export type PublicProfile = Pick<User, "id" | "email" | "createdAt"> & {
  name: string | null;
  surname: string | null;
  birthDate: Date | null;
};
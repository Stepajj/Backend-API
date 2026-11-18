import { userRepository } from "../repositories/user.repository.js";
import type { User } from "../types/user.js";

export async function getUserById(userId: string): Promise<User | undefined> {
  return (await userRepository.findById(userId)) ?? undefined;
}

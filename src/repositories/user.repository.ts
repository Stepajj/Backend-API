import { prisma } from "../infrastructure/database/prisma.js";
import type { ProfileUpdateData } from "../types/profile.js";

export const userRepository = {
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },
  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },
  async create(user: { id: string; email: string; passwordHash: string; createdAt: Date }) {
    return prisma.user.create({ data: user });
  },
  async updateById(id: string, data: ProfileUpdateData) {
    try { return await prisma.user.update({ where: { id }, data }); }
    catch (error) { if ((error as { code?: string }).code === "P2025") return undefined; throw error; }
  }
};

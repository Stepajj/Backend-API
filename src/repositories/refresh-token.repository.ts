import { prisma } from "../infrastructure/database/prisma.js";
import type { RefreshTokenRecord } from "../types/refresh-token.js";

export const refreshTokenRepository = {
  async create(record: RefreshTokenRecord) { return prisma.refreshToken.create({ data: record }); },
  async findByHash(tokenHash: string) { return prisma.refreshToken.findUnique({ where: { tokenHash } }); },
  async findById(id: string) { return prisma.refreshToken.findUnique({ where: { id } }); },
  async findByFamilyId(familyId: string) { return prisma.refreshToken.findMany({ where: { familyId } }); },
  async revokeIfActive(id: string, now = new Date()) {
    return prisma.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
  },
  async revokeByHash(tokenHash: string, now = new Date()) {
    return prisma.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } });
  },
  async rotate(currentId: string, oldTokenHash: string, next: RefreshTokenRecord) {
    return prisma.$transaction(async (tx) => {
      const changed = await tx.refreshToken.updateMany({
        where: { id: currentId, tokenHash: oldTokenHash, revokedAt: null, replacedByTokenId: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), replacedByTokenId: next.id }
      });
      if (changed.count !== 1) return false;
      await tx.refreshToken.create({ data: next });
      return true;
    });
  },
  async revokeFamily(familyId: string, now = new Date()) {
    await prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }
};

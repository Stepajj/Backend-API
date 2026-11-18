import { randomUUID } from "node:crypto";
import argon2 from "argon2";

import { userRepository } from "../repositories/user.repository.js";
import { createAccessToken } from "../security/access-token.js";
import { hashRefreshToken } from "../security/refresh-token.js";
import type { RegistrationInput } from "../schemas/auth.schema.js";
import type { LoginInput } from "../schemas/auth.schema.js";
import type { User } from "../types/user.js";
import { env } from "../config/env.js";
import { refreshTokenRepository } from "../repositories/refresh-token.repository.js";
import { generateRefreshToken } from "../security/refresh-token.js";

type RegistrationResult =
  | { success: true; user: User }
  | { success: false; reason: "EMAIL_ALREADY_EXISTS" };

export async function registerUser(
  input: RegistrationInput
): Promise<RegistrationResult> {
  const email = input.email.trim().toLowerCase();

  if (await userRepository.findByEmail(email)) {
    return {
      success: false,
      reason: "EMAIL_ALREADY_EXISTS"
    };
  }

  const passwordHash = await argon2.hash(input.password);

  // Check again after hashing to guard against concurrent registrations.
  if (await userRepository.findByEmail(email)) {
    return {
      success: false,
      reason: "EMAIL_ALREADY_EXISTS"
    };
  }

  const user: User = {
    id: randomUUID(),
    email,
    passwordHash,
    createdAt: new Date()
  };

  try {
    await userRepository.create(user);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { success: false, reason: "EMAIL_ALREADY_EXISTS" };
    throw error;
  }

  return {
    success: true,
    user
  };
}

export async function loginUser(input: LoginInput): Promise<
  | { success: true; user: User; accessToken: string; refreshToken: string}
  | { success: false; reason: "INVALID_CREDENTIALS" }
>  {
     const email = input.email.trim().toLowerCase();

  const user = await userRepository.findByEmail(email);

  if (!user) {
    return {
      success: false,
      reason: "INVALID_CREDENTIALS"
    };
  }

  if (user.status !== "ACTIVE") return { success: false, reason: "INVALID_CREDENTIALS" };

  const passwordMatches = await argon2.verify(
    user.passwordHash,
    input.password
  );

  if (!passwordMatches) {
    return {
      success: false,
      reason: "INVALID_CREDENTIALS"
    };
  }
  const accessToken = await createAccessToken(user.id);
  const { token: refreshToken, tokenHash } = generateRefreshToken();

const refreshTokenId = randomUUID();
const familyId = randomUUID();

const expiresAt = new Date(
  Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000
);

await refreshTokenRepository.create({
  id: refreshTokenId,
  tokenHash,
  userId: user.id,
  familyId,
  expiresAt,
  revokedAt: null,
  replacedByTokenId: null
});

  return {
  success: true,
  user,
  accessToken,
  refreshToken
};
}

export async function refreshAccessToken(token: string) {
  const tokenHash = hashRefreshToken(token);
  const record = await refreshTokenRepository.findByHash(tokenHash);

  if (!record) {
    return { success: false as const };
  }

  const revokeFamily = (familyId: string) => refreshTokenRepository.revokeFamily(familyId);

  // A revoked or replaced token has been reused.
  if (record.revokedAt || record.replacedByTokenId) {
    await revokeFamily(record.familyId);
    return { success: false as const };
  }

  if (record.expiresAt <= new Date()) {
    await refreshTokenRepository.revokeIfActive(record.id);

    return { success: false as const };
  }

  const user = await userRepository.findById(record.userId);

  if (!user || user.status !== "ACTIVE") {
    await revokeFamily(record.familyId);
    return { success: false as const };
  }

  const accessToken = await createAccessToken(user.id);

  // Recheck after the async operation to reduce refresh races.
  const currentRecord = await refreshTokenRepository.findByHash(tokenHash);

  if (
    !currentRecord ||
    currentRecord.revokedAt ||
    currentRecord.replacedByTokenId ||
    currentRecord.expiresAt <= new Date()
  ) {
    await revokeFamily(record.familyId);
    return { success: false as const };
  }

  const {
    token: newRefreshToken,
    tokenHash: newTokenHash
  } = generateRefreshToken();

  const newTokenId = randomUUID();
  const now = new Date();

  const rotated = await refreshTokenRepository.rotate(currentRecord.id, tokenHash, {
    id: newTokenId,
    tokenHash: newTokenHash,
    userId: user.id,
    familyId: currentRecord.familyId,
    expiresAt: new Date(
      now.getTime() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    ),
    revokedAt: null,
    replacedByTokenId: null
  });
  if (!rotated) {
    await revokeFamily(currentRecord.familyId);
    return { success: false as const };
  }

  return {
    success: true as const,
    accessToken,
    refreshToken: newRefreshToken
  };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const tokenHash = hashRefreshToken(token);
  const record = await refreshTokenRepository.findByHash(tokenHash);

  if (!record || record.revokedAt) {
    return;
  }

  await refreshTokenRepository.revokeByHash(tokenHash);
}

import { userRepository } from "../repositories/user.repository.js";
import type { User } from "../types/user.js";
import type { ProfileUpdateData, PublicProfile } from "../types/profile.js";

function toPublicProfile(user: User): PublicProfile {
    return {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        name: user.name ?? null,
        surname: user.surname ?? null,
        birthDate: user.birthDate ?? null
    };
}

export async function getProfile(userId: string): Promise<PublicProfile | undefined> {
    const user = await userRepository.findById(userId);
    return user ? toPublicProfile(user) : undefined;
}

export async function updateProfile(
    userId: string,
    data: ProfileUpdateData
): Promise<PublicProfile | undefined> {
    const updatedUser = await userRepository.updateById(userId, data);
    return updatedUser ? toPublicProfile(updatedUser) : undefined;
}


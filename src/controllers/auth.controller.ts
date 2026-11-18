import type { RequestHandler } from "express";
import { registerUser } from "../services/auth.service.js";
import { loginUser } from "../services/auth.service.js";
import { getProfile, updateProfile } from "../services/profile.service.js";
import { env } from "../config/env.js";
import { revokeRefreshToken } from "../services/auth.service.js";
import { refreshAccessToken } from "../services/auth.service.js"; 


export const registerController: RequestHandler = async (req, res) => {
  const result = await registerUser(req.body);

  if (!result.success) {
    res.status(409).json({
      error: {
        code: "EMAIL_ALREADY_EXISTS",
        message: "An account with this email already exists"
      }
    });

    return;
  }

  const { id, email, createdAt } = result.user;

  res.status(201).json({
    user: {
      id,
      email,
      createdAt
    }
  });
};  

export const loginController: RequestHandler = async (req, res) => {
  const result = await loginUser(req.body);

  if (!result.success) {
    res.status(401).json({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password"
      }
    });

    return;
  }

  const { id, email, createdAt } = result.user;
  res.cookie("refreshToken", result.refreshToken, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api",
  maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000
});

  res.status(200).json({
  user: {
    id,
    email,
    createdAt
  },
  accessToken: result.accessToken
});
};

export const getCurrentUserController: RequestHandler = async (req, res) => {
  const user = await getProfile(req.auth!.userId);

  if (!user) {
    res.status(404).json({
      error: {
        code: "USER_NOT_FOUND",
        message: "User not found"
      }
    });
    return;
  }

  res.status(200).json({
    user
  });
};

export const updateCurrentUserProfileController: RequestHandler = async (req, res) => {
  const user = await updateProfile(req.auth!.userId, req.body);

  if (!user) {
    res.status(404).json({
      error: {
        code: "USER_NOT_FOUND",
        message: "User not found"
      }
    });
    return;
  }

  res.status(200).json({ user });
};

export const refreshController: RequestHandler = async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;

  if (typeof refreshToken !== "string") {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Refresh token required"
      }
    });
    return;
  }

  const result = await refreshAccessToken(refreshToken);

  if (!result.success) {
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api"
    });

    res.status(401).json({
      error: {
        code: "INVALID_REFRESH_TOKEN",
        message: "Refresh token is invalid or expired"
      }
    });
    return;
  }

  res.cookie("refreshToken", result.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000
  });

  res.status(200).json({
    accessToken: result.accessToken
  });
};  

export const logoutController: RequestHandler = async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;

  if (typeof refreshToken === "string") {
    await revokeRefreshToken(refreshToken);
  }

  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api"
  });

  res.status(204).end();
};

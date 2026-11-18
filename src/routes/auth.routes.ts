import { Router } from "express";
import { validateRegistrationMiddleware } from "../middleware/validate-registration.middleware.js";
import { validateLoginMiddleware } from "../middleware/validate-login.middleware.js";
import { getCurrentUserController, loginController, logoutController, registerController, updateCurrentUserProfileController } from "../controllers/auth.controller.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { refreshController } from "../controllers/auth.controller.js";
import { validateProfileUpdateMiddleware } from "../middleware/validate-profile-update.middleware.js";

const authRouter = Router();

authRouter.post(
  "/register",
  validateRegistrationMiddleware,
  registerController,
);


authRouter.post(
  "/login",
  validateLoginMiddleware,
  loginController,
);

authRouter.get(
  "/me",
  authMiddleware,
  getCurrentUserController
);
authRouter.patch(
  "/me",
  authMiddleware,
  validateProfileUpdateMiddleware,
  updateCurrentUserProfileController
);
authRouter.post("/refresh", refreshController);

authRouter.post("/logout", logoutController);
export default authRouter;
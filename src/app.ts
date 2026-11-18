import express from "express";
import healthRouter from "./routes/health.routes.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import authRouter from "./routes/auth.routes.js";
import { errorHandlerMiddleware } from "./middleware/error-handler.middleware.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { createMarketplaceRouter } from "./routes/marketplace.routes.js";
import { randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { uploadDirectory } from "./infrastructure/storage/local-image-storage.js";
import { logger } from "./infrastructure/logging/logger.js";
import { paymentGateway as configuredPaymentGateway, type PaymentGateway } from "./infrastructure/payments/payment-gateway.js";


const openApi = {
  openapi: "3.0.3",
  info: { title: "ReGear API", version: "1.0.0" },
  servers: [{ url: "/api/v1" }],
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  paths: {
    "/health/": { servers: [{ url: "" }], get: { summary: "Liveness probe" } }, "/health/ready": { servers: [{ url: "" }], get: { summary: "Readiness probe including database connectivity" } },
    "/auth/register": { post: { summary: "Register buyer" } }, "/auth/login": { post: { summary: "Login" } },
    "/auth/refresh": { post: { summary: "Rotate refresh token" } }, "/auth/logout": { post: { summary: "Logout" } }, "/auth/me": { get: { summary: "Current profile", security: [{ bearerAuth: [] }] }, patch: { summary: "Update current profile", security: [{ bearerAuth: [] }] } },
    "/seller/applications": { post: { summary: "Apply to sell", security: [{ bearerAuth: [] }] } },
    "/admin/seller-applications": { get: { summary: "List pending seller applications", security: [{ bearerAuth: [] }] } },
    "/admin/seller-applications/{id}": { patch: { summary: "Review seller application", security: [{ bearerAuth: [] }] } },
    "/seller/shop": { get: { summary: "Get own shop", security: [{ bearerAuth: [] }] }, post: { summary: "Create shop", security: [{ bearerAuth: [] }] }, patch: { summary: "Update shop", security: [{ bearerAuth: [] }] } },
    "/shops/{id}": { get: { summary: "Public shop" } }, "/categories": { get: { summary: "List active categories" } },
    "/admin/categories": { post: { summary: "Create category", security: [{ bearerAuth: [] }] } }, "/admin/categories/{id}": { patch: { summary: "Update category", security: [{ bearerAuth: [] }] } },
    "/seller/products": { get: { summary: "List own products", security: [{ bearerAuth: [] }] }, post: { summary: "Create product", security: [{ bearerAuth: [] }] } },
    "/seller/products/{id}": { get: { summary: "Get own product", security: [{ bearerAuth: [] }] }, patch: { summary: "Update own product", security: [{ bearerAuth: [] }] }, delete: { summary: "Archive own product", security: [{ bearerAuth: [] }] } }, "/seller/products/{id}/images": { post: { summary: "Upload a product image", security: [{ bearerAuth: [] }] } },
    "/seller/products/{id}/submit": { post: { summary: "Submit product for moderation", security: [{ bearerAuth: [] }] } }, "/products": { get: { summary: "Public catalog" } }, "/products/{id}": { get: { summary: "Product details" } },
    "/admin/products/pending": { get: { summary: "Pending moderation", security: [{ bearerAuth: [] }] } }, "/admin/products/{id}/approve": { post: { summary: "Approve product", security: [{ bearerAuth: [] }] } }, "/admin/products/{id}/reject": { post: { summary: "Reject product", security: [{ bearerAuth: [] }] } },
    "/cart": { get: { summary: "Get cart", security: [{ bearerAuth: [] }] }, delete: { summary: "Clear cart", security: [{ bearerAuth: [] }] } }, "/cart/items": { post: { summary: "Add cart item", security: [{ bearerAuth: [] }] } }, "/cart/items/{id}": { patch: { summary: "Change quantity", security: [{ bearerAuth: [] }] }, delete: { summary: "Remove item", security: [{ bearerAuth: [] }] } },
    "/checkout": { post: { summary: "Reserve inventory and create Stripe Checkout session", security: [{ bearerAuth: [] }], parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }] } },
    "/payments/stripe/webhook": { post: { summary: "Verify and process Stripe webhook" } }, "/payments/{id}": { get: { summary: "Get payment", security: [{ bearerAuth: [] }] } },
    "/orders": { get: { summary: "Buyer order history", security: [{ bearerAuth: [] }] } }, "/orders/{id}": { get: { summary: "Buyer order details", security: [{ bearerAuth: [] }] } },
    "/seller/orders": { get: { summary: "Seller orders", security: [{ bearerAuth: [] }] } }, "/seller/orders/{id}": { get: { summary: "Seller order details", security: [{ bearerAuth: [] }] } }, "/seller/orders/{id}/status": { patch: { summary: "Advance fulfillment state", security: [{ bearerAuth: [] }] } },
    "/admin/users": { get: { summary: "List users", security: [{ bearerAuth: [] }] } }, "/admin/orders": { get: { summary: "List orders", security: [{ bearerAuth: [] }] } }
  }
};


export function createApp(options: { paymentGateway?: PaymentGateway | null } = {}) {
const app = express();
app.use(helmet());
app.use((req, res, next) => { const supplied = req.get("x-request-id"); const id = supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : randomUUID(); res.setHeader("x-request-id", id); next(); });
app.use(pinoHttp({
  logger,
  redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.stripe-signature", "req.body.password", "req.body.passwordHash", "res.headers.set-cookie", "err.header", "err.payload"],
  genReqId: (_req, res) => String(res.getHeader("x-request-id") ?? randomUUID())
}));

app.disable("x-powered-by");


app.use(
  cors({
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3001").split(",").map(value => value.trim()).filter(Boolean),
    credentials: true,
  }),
);


app.use("/api/v1/payments/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "10kb" }));
app.use("/uploads", express.static(uploadDirectory, { dotfiles: "deny", index: false, immutable: true, maxAge: "7d" }));
app.use(cookieParser());
app.use("/health", healthRouter);
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many authentication requests; try again later" } })
});
app.use("/api/auth", authRateLimit, authRouter);
app.use("/api/v1", createMarketplaceRouter(options.paymentGateway === undefined ? configuredPaymentGateway : options.paymentGateway));
app.use("/api/v1/auth", authRateLimit, authRouter);
app.get("/api/v1/openapi.json", (_req, res) => res.json(openApi));
app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openApi));
app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);
return app;
}

const app = createApp();
export default app;

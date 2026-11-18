import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { imageUpload } from "../infrastructure/storage/local-image-storage.js";
import { paymentGateway as configuredPaymentGateway, PaymentGatewayError, stripeWebhookVerifier, type PaymentGateway } from "../infrastructure/payments/payment-gateway.js";
import { prisma } from "../infrastructure/database/prisma.js";
import { authMiddleware } from "../middleware/auth.middleware.js";
import { requireRole } from "../middleware/role.middleware.js";
import type Stripe from "stripe";
import { processStripeCheckoutEvent, releaseCheckoutReservation, reserveCartForCheckout, type CheckoutReservation } from "../services/checkout.service.js";

export function createMarketplaceRouter(paymentGateway: PaymentGateway | null = configuredPaymentGateway) {
const router = Router();
const seller = [authMiddleware, requireRole("SELLER")];
const admin = [authMiddleware, requireRole("ADMIN")];
const buyer = [authMiddleware, requireRole("BUYER", "SELLER", "ADMIN")];
const routeParam = (req: Request, name: string): string => { const value = req.params[name]; if (typeof value !== "string") throw Object.assign(new Error("Invalid route parameter"), { status: 400, code: "INVALID_PARAMETER" }); return value; };
const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
const safe = (handler: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler => (req, res, next) => { void Promise.resolve(handler(req, res, next)).catch(next); };
const nameSchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(2000).optional() });
const productSchema = z.object({ name: z.string().trim().min(2).max(160), description: z.string().trim().min(5).max(10000), priceCents: z.number().int().positive().max(100_000_000), categoryId: z.string().uuid(), condition: z.enum(["NEW", "LIKE_NEW", "GOOD", "FAIR"]), quantity: z.number().int().min(0).max(100_000) });
const createStripeSessionForOrder = async (orderId: string, buyerId: string, key: string, items: Array<{ name: string; unitAmount: number; quantity: number }>) => {
  if (!paymentGateway) throw Object.assign(new Error("Stripe payments are not configured"), { status: 503, code: "PAYMENTS_UNAVAILABLE" });
  return paymentGateway.createCheckoutSession({
    orderId,
    idempotencyKey: `regear:${buyerId}:${key}`,
    successUrl: `${process.env.APP_URL ?? "http://localhost:3001"}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${process.env.APP_URL ?? "http://localhost:3001"}/checkout/cancel`,
    lineItems: items.map(item => ({ ...item, currency: "eur" }))
  });
};
const resumePendingCheckout = async (orderId: string, buyerId: string, key: string, items: Array<{ name: string; unitAmount: number; quantity: number }>) => {
  const session = await createStripeSessionForOrder(orderId, buyerId, key, items);
  const payment = await prisma.payment.update({ where: { orderId }, data: { stripeSessionId: session.id, checkoutUrl: session.url } });
  return { orderId, paymentId: payment.id, checkoutUrl: session.url };
};

router.post("/seller/applications", authMiddleware, requireRole("BUYER"), safe(async (req, res) => {
  const input = z.object({ businessName: z.string().trim().min(2).max(120), description: z.string().max(2000).optional() }).safeParse(req.body);
  if (!input.success) return fail(res, 400, "VALIDATION_ERROR", input.error.issues[0]?.message ?? "Invalid input");
  const exists = await prisma.sellerApplication.findUnique({ where: { userId: req.auth!.userId } });
  if (exists) return fail(res, 409, "APPLICATION_EXISTS", "A seller application already exists");
  return res.status(201).json({ application: await prisma.sellerApplication.create({ data: { ...input.data, userId: req.auth!.userId } }) });
}));
router.get("/admin/seller-applications", ...admin, safe(async (_req, res) => res.json({ applications: await prisma.sellerApplication.findMany({ where: { status: "PENDING" }, include: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: "asc" } }) })));
router.patch("/admin/seller-applications/:id", ...admin, safe(async (req, res) => {
  const input = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(3).max(500).optional() }).safeParse(req.body);
  if (!input.success || (input.success && input.data.decision === "REJECTED" && !input.data.reason)) return fail(res, 400, "VALIDATION_ERROR", "Decision and rejection reason are required");
  const result = await prisma.$transaction(async tx => {
    const app = await tx.sellerApplication.findUnique({ where: { id: routeParam(req, "id") } });
    if (!app) throw Object.assign(new Error("Seller application not found"), { status: 404, code: "APPLICATION_NOT_FOUND" });
    const claimed = await tx.sellerApplication.updateMany({ where: { id: app.id, status: "PENDING" }, data: { status: input.data.decision, rejectionReason: input.data.reason, reviewedAt: new Date() } });
    if (claimed.count !== 1) throw Object.assign(new Error("Seller application has already been reviewed"), { status: 409, code: "APPLICATION_ALREADY_REVIEWED" });
    const updated = await tx.sellerApplication.findUniqueOrThrow({ where: { id: app.id } });
    if (input.data.decision === "APPROVED") { await tx.sellerProfile.create({ data: { userId: app.userId } }); await tx.user.update({ where: { id: app.userId }, data: { role: "SELLER" } }); }
    await tx.auditLog.create({ data: { actorId: req.auth!.userId, action: `SELLER_APPLICATION_${input.data.decision}`, entityType: "SellerApplication", entityId: app.id } });
    return updated;
  });
  return res.json({ application: result });
}));

router.post("/seller/shop", ...seller, safe(async (req, res) => {
  const input = nameSchema.safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Valid shop name is required");
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.auth!.userId } });
  if (!profile) return fail(res, 403, "SELLER_PROFILE_REQUIRED", "Seller profile required");
  const shop = await prisma.shop.create({ data: { ...input.data, sellerId: profile.id } }); return res.status(201).json({ shop });
}));
router.get("/seller/shop", ...seller, safe(async (req, res) => { const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.auth!.userId } }); return res.json({ shop: profile ? await prisma.shop.findUnique({ where: { sellerId: profile.id } }) : null }); }));
router.patch("/seller/shop", ...seller, safe(async (req, res) => { const input = nameSchema.partial().safeParse(req.body); if (!input.success || !Object.keys(input.data ?? {}).length) return fail(res, 400, "VALIDATION_ERROR", "Shop update required"); const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.auth!.userId } }); if (!profile) return fail(res, 404, "SHOP_NOT_FOUND", "Shop not found"); const shop = await prisma.shop.update({ where: { sellerId: profile.id }, data: input.data }); return res.json({ shop }); }));
router.get("/shops/:id", safe(async (req, res) => { const shop = await prisma.shop.findUnique({ where: { id: routeParam(req, "id") }, include: { seller: { include: { products: { where: { status: "APPROVED" }, include: { images: true, inventory: true } } } } } }); if (!shop) return fail(res, 404, "SHOP_NOT_FOUND", "Shop not found"); return res.json({ shop }); }));

router.get("/categories", safe(async (_req, res) => res.json({ categories: await prisma.category.findMany({ where: { active: true }, orderBy: { name: "asc" } }) })));
router.post("/admin/categories", ...admin, safe(async (req, res) => { const input = z.object({ name: z.string().trim().min(2).max(100), slug: z.string().regex(/^[a-z0-9-]+$/) }).safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid category"); return res.status(201).json({ category: await prisma.category.create({ data: input.data }) }); }));
router.patch("/admin/categories/:id", ...admin, safe(async (req, res) => { const input = z.object({ name: z.string().trim().min(2).max(100).optional(), active: z.boolean().optional() }).safeParse(req.body); if (!input.success || !Object.keys(input.data ?? {}).length) return fail(res, 400, "VALIDATION_ERROR", "Invalid category update"); return res.json({ category: await prisma.category.update({ where: { id: routeParam(req, "id") }, data: input.data }) }); }));

router.post("/seller/products", ...seller, safe(async (req, res) => {
  const input = productSchema.safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", input.error.issues[0]?.message ?? "Invalid product");
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: req.auth!.userId } }); if (!profile) return fail(res, 403, "SELLER_PROFILE_REQUIRED", "Seller profile required");
  const category = await prisma.category.findFirst({ where: { id: input.data.categoryId, active: true } }); if (!category) return fail(res, 400, "INVALID_CATEGORY", "Category is not active");
  const { quantity, ...data } = input.data;
  const product = await prisma.product.create({ data: { ...data, sellerId: profile.id, inventory: { create: { available: quantity } } }, include: { inventory: true, images: true } }); return res.status(201).json({ product });
}));
router.get("/seller/products", ...seller, safe(async (req, res) => { const list = await prisma.product.findMany({ where: { seller: { userId: req.auth!.userId }, archivedAt: null }, include: { inventory: true, images: true }, orderBy: { createdAt: "desc" } }); return res.json({ products: list }); }));
router.get("/seller/products/:id", ...seller, safe(async (req, res) => { const product = await prisma.product.findFirst({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId } }, include: { inventory: true, images: true } }); if (!product) return fail(res, 404, "PRODUCT_NOT_FOUND", "Product not found"); return res.json({ product }); }));
router.patch("/seller/products/:id", ...seller, safe(async (req, res) => { const input = productSchema.partial().safeParse(req.body); if (!input.success || !Object.keys(input.data ?? {}).length) return fail(res, 400, "VALIDATION_ERROR", "Invalid product update"); if (input.data.categoryId && !await prisma.category.findFirst({ where: { id: input.data.categoryId, active: true } })) return fail(res, 400, "INVALID_CATEGORY", "Category is not active"); const product = await prisma.$transaction(async tx => { const productId = routeParam(req, "id"); await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`; const current = await tx.product.findFirst({ where: { id: productId, seller: { userId: req.auth!.userId } } }); if (!current) return null; const { quantity, ...data } = input.data; const moderationFieldsChanged = ["name", "description", "priceCents", "categoryId", "condition"].some(field => Object.hasOwn(data, field)); const update = await tx.product.update({ where: { id: current.id }, data: { ...data, ...(["APPROVED", "PENDING_MODERATION"].includes(current.status) && moderationFieldsChanged ? { status: "PENDING_MODERATION", rejectionReason: null } : {}) } }); if (quantity !== undefined) await tx.inventory.update({ where: { productId: current.id }, data: { available: quantity } }); return update; }); if (!product) return fail(res, 404, "PRODUCT_NOT_FOUND", "Product not found"); return res.json({ product }); }));
router.delete("/seller/products/:id", ...seller, safe(async (req, res) => { const product = await prisma.product.updateMany({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId } }, data: { status: "ARCHIVED", archivedAt: new Date() } }); if (!product.count) return fail(res, 404, "PRODUCT_NOT_FOUND", "Product not found"); return res.status(204).end(); }));
router.post("/seller/products/:id/images", ...seller, safe(async (req, res, next) => {
  const product = await prisma.product.findFirst({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId } }, select: { id: true } });
  if (!product) return fail(res, 404, "PRODUCT_NOT_FOUND", "Product not found");
  imageUpload.single("image")(req, res, error => { if (error) return next(error); void (async () => {
    if (!req.file) return fail(res, 400, "INVALID_IMAGE", "Upload a JPEG, PNG, or WebP image up to 5 MB");
    const { readFile, unlink } = await import("node:fs/promises");
    const bytes = await readFile(req.file.path);
    const valid = (req.file.mimetype === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)
      || (req.file.mimetype === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (req.file.mimetype === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
    if (!valid) { await unlink(req.file.path); return fail(res, 400, "INVALID_IMAGE", "File content does not match a supported image format"); }
    try {
      const image = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${product.id} FOR UPDATE`;
        const imageCount = await tx.productImage.count({ where: { productId: product.id } });
        if (imageCount >= 10) throw Object.assign(new Error("A product can have at most 10 images"), { status: 409, code: "IMAGE_LIMIT_REACHED" });
        const created = await tx.productImage.create({ data: { productId: product.id, path: `/uploads/${req.file!.filename}`, sortOrder: imageCount } });
        await tx.product.updateMany({ where: { id: product.id, status: "APPROVED" }, data: { status: "PENDING_MODERATION" } });
        return created;
      });
      return res.status(201).json({ image });
    } catch (error) { await unlink(req.file.path).catch(() => undefined); throw error; }
  })().catch(next); });
}));
router.get("/products", safe(async (req, res) => {
  const filters = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), minPrice: z.coerce.number().int().min(0).max(100_000_000).optional(), maxPrice: z.coerce.number().int().min(0).max(100_000_000).optional(), categoryId: z.string().uuid().optional(), q: z.string().trim().min(1).max(120).optional() }).safeParse(req.query);
  if (!filters.success) return fail(res, 400, "VALIDATION_ERROR", filters.error.issues[0]?.message ?? "Invalid catalog filters");
  const { page, limit, minPrice, maxPrice, categoryId, q } = filters.data;
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) return fail(res, 400, "VALIDATION_ERROR", "minPrice must not exceed maxPrice");
  const where = { status: "APPROVED" as const, inventory: { available: { gt: 0 } }, ...(categoryId ? { categoryId } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { description: { contains: q, mode: "insensitive" as const } }] } : {}), ...(minPrice !== undefined || maxPrice !== undefined ? { priceCents: { ...(minPrice !== undefined ? { gte: minPrice } : {}), ...(maxPrice !== undefined ? { lte: maxPrice } : {}) } } : {}) };
  const [products, total] = await Promise.all([prisma.product.findMany({ where, include: { images: true, inventory: true, category: true }, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" } }), prisma.product.count({ where })]);
  return res.json({ products, page, limit, total });
}));
router.get("/products/:id", safe(async (req, res) => { const product = await prisma.product.findFirst({ where: { id: routeParam(req, "id"), status: "APPROVED" }, include: { images: true, inventory: true, category: true, seller: { include: { shop: true } } } }); if (!product) return fail(res, 404, "PRODUCT_NOT_FOUND", "Product not found"); return res.json({ product }); }));

router.get("/admin/products/pending", ...admin, safe(async (_req, res) => res.json({ products: await prisma.product.findMany({ where: { status: "PENDING_MODERATION" }, include: { seller: { include: { shop: true } }, category: true, images: true } }) })));
router.post("/seller/products/:id/submit", ...seller, safe(async (req, res) => { const changed = await prisma.product.updateMany({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId }, status: { in: ["DRAFT", "REJECTED"] } }, data: { status: "PENDING_MODERATION", rejectionReason: null } }); if (!changed.count) return fail(res, 409, "INVALID_PRODUCT_STATE", "Product cannot be submitted"); return res.json({ status: "PENDING_MODERATION" }); }));
router.post("/admin/products/:id/approve", ...admin, safe(async (req, res) => { const product = await prisma.$transaction(async tx => { const p = await tx.product.update({ where: { id: routeParam(req, "id"), status: "PENDING_MODERATION" }, data: { status: "APPROVED", rejectionReason: null } }); await tx.auditLog.create({ data: { actorId: req.auth!.userId, action: "PRODUCT_APPROVED", entityType: "Product", entityId: p.id } }); return p; }); return res.json({ product }); }));
router.post("/admin/products/:id/reject", ...admin, safe(async (req, res) => { const input = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Rejection reason required"); const product = await prisma.$transaction(async tx => { const p = await tx.product.update({ where: { id: routeParam(req, "id"), status: "PENDING_MODERATION" }, data: { status: "REJECTED", rejectionReason: input.data.reason } }); await tx.auditLog.create({ data: { actorId: req.auth!.userId, action: "PRODUCT_REJECTED", entityType: "Product", entityId: p.id, metadata: { reason: input.data.reason } } }); return p; }); return res.json({ product }); }));

router.get("/cart", ...buyer, safe(async (req, res) => { const cart = await prisma.cart.upsert({ where: { userId: req.auth!.userId }, create: { userId: req.auth!.userId }, update: {}, include: { items: { include: { product: { include: { inventory: true, images: true } } } } } }); return res.json({ cart }); }));
router.post("/cart/items", ...buyer, safe(async (req, res) => { const input = z.object({ productId: z.string().uuid(), quantity: z.number().int().positive() }).safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Valid product and positive quantity required"); const p = await prisma.product.findFirst({ where: { id: input.data.productId, status: "APPROVED", inventory: { available: { gte: input.data.quantity } } } }); if (!p) return fail(res, 409, "PRODUCT_UNAVAILABLE", "Product unavailable or insufficient stock"); const cart = await prisma.cart.upsert({ where: { userId: req.auth!.userId }, create: { userId: req.auth!.userId }, update: {} }); const item = await prisma.cartItem.upsert({ where: { cartId_productId: { cartId: cart.id, productId: p.id } }, create: { cartId: cart.id, productId: p.id, quantity: input.data.quantity }, update: { quantity: input.data.quantity } }); return res.status(201).json({ item }); }));
router.patch("/cart/items/:id", ...buyer, safe(async (req, res) => { const input = z.object({ quantity: z.number().int().positive() }).safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Positive quantity required"); const item = await prisma.cartItem.findFirst({ where: { id: routeParam(req, "id"), cart: { userId: req.auth!.userId }, product: { status: "APPROVED", inventory: { available: { gte: input.data.quantity } } } } }); if (!item) return fail(res, 404, "CART_ITEM_NOT_FOUND", "Cart item not found or unavailable"); return res.json({ item: await prisma.cartItem.update({ where: { id: item.id }, data: input.data }) }); }));
router.delete("/cart/items/:id", ...buyer, safe(async (req, res) => { const result = await prisma.cartItem.deleteMany({ where: { id: routeParam(req, "id"), cart: { userId: req.auth!.userId } } }); if (!result.count) return fail(res, 404, "CART_ITEM_NOT_FOUND", "Cart item not found"); return res.status(204).end(); }));
router.delete("/cart", ...buyer, safe(async (req, res) => { await prisma.cartItem.deleteMany({ where: { cart: { userId: req.auth!.userId } } }); return res.status(204).end(); }));

router.post("/checkout", ...buyer, safe(async (req, res) => {
  const key = req.get("idempotency-key");
  if (!key || key.trim().length === 0 || key !== key.trim() || key.length > 200) return fail(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a non-empty Idempotency-Key header of at most 200 characters");
  const prior = await prisma.order.findUnique({ where: { buyerId_idempotencyKey: { buyerId: req.auth!.userId, idempotencyKey: key } }, include: { payment: true, items: true } });
  if (prior) {
    if (prior.payment?.checkoutUrl) return res.status(200).json({ orderId: prior.id, checkoutUrl: prior.payment.checkoutUrl, paymentId: prior.payment.id });
    if (prior.status !== "PENDING_PAYMENT" || !prior.payment) return fail(res, 409, "IDEMPOTENCY_KEY_FINAL", "This checkout key is already associated with a completed or failed checkout");
    if (!paymentGateway) return fail(res, 503, "PAYMENTS_UNAVAILABLE", "Stripe payments are not configured");
    try {
      return res.status(200).json(await resumePendingCheckout(prior.id, req.auth!.userId, key, prior.items.map(item => ({ name: item.productName, unitAmount: item.unitPriceCents, quantity: item.quantity }))));
    } catch (error) {
      req.log?.warn({ err: error, orderId: prior.id }, "Could not resume the pending Stripe Checkout Session; retry with the same idempotency key");
      return fail(res, 503, "CHECKOUT_SESSION_RETRYABLE", "The checkout is pending Stripe confirmation; retry with the same idempotency key");
    }
  }
  if (!paymentGateway) return fail(res, 503, "PAYMENTS_UNAVAILABLE", "Stripe payments are not configured");
  let reservation: CheckoutReservation;
  try {
    reservation = await reserveCartForCheckout(req.auth!.userId, key);
  } catch (error) {
    const idempotentOrder = await prisma.order.findUnique({ where: { buyerId_idempotencyKey: { buyerId: req.auth!.userId, idempotencyKey: key } }, include: { payment: true, items: true } });
    if (idempotentOrder) {
      if (idempotentOrder.payment?.checkoutUrl) return res.status(200).json({ orderId: idempotentOrder.id, checkoutUrl: idempotentOrder.payment.checkoutUrl, paymentId: idempotentOrder.payment.id });
      if (idempotentOrder.status !== "PENDING_PAYMENT") return fail(res, 409, "IDEMPOTENCY_KEY_FINAL", "This checkout key is already associated with a completed or failed checkout");
      try {
        return res.status(200).json(await resumePendingCheckout(idempotentOrder.id, req.auth!.userId, key, idempotentOrder.items.map(item => ({ name: item.productName, unitAmount: item.unitPriceCents, quantity: item.quantity }))));
      } catch (resumeError) {
        req.log?.warn({ err: resumeError, orderId: idempotentOrder.id }, "Could not resume the pending Stripe Checkout Session");
        return fail(res, 503, "CHECKOUT_SESSION_RETRYABLE", "The checkout is pending Stripe confirmation; retry with the same idempotency key");
      }
    }
    throw error;
  }
  let createdSessionId: string | undefined;
  try {
    const session = await createStripeSessionForOrder(reservation.order.id, req.auth!.userId, key, reservation.items);
    createdSessionId = session.id;
    const payment = await prisma.payment.update({ where: { orderId: reservation.order.id }, data: { stripeSessionId: session.id, checkoutUrl: session.url } });
    return res.status(201).json({ orderId: reservation.order.id, paymentId: payment.id, checkoutUrl: session.url });
  } catch (error) {
    if (!createdSessionId && (!(error instanceof PaymentGatewayError) || error.outcome === "unknown")) {
      req.log?.warn({ err: error, orderId: reservation.order.id }, "Stripe Checkout creation outcome is unknown; inventory remains reserved for same-key retry");
      return fail(res, 503, "CHECKOUT_SESSION_RETRYABLE", "Stripe confirmation is pending; retry with the same idempotency key");
    }
    if (createdSessionId) {
      try { await paymentGateway.expireCheckoutSession(createdSessionId); }
      catch (expirationError) {
        req.log?.error({ err: expirationError, orderId: reservation.order.id }, "Could not expire a Checkout Session after checkout persistence failed");
        return fail(res, 503, "CHECKOUT_RECONCILIATION_REQUIRED", "Payment session is being reconciled; inventory remains reserved");
      }
    }
    await releaseCheckoutReservation(reservation);
    if (error instanceof PaymentGatewayError) return fail(res, 502, "CHECKOUT_SESSION_FAILED", "Stripe rejected the Checkout Session request");
    throw error;
  }
}));

router.post("/payments/stripe/webhook", safe(async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.includes("replace_me")) return fail(res, 503, "PAYMENTS_UNAVAILABLE", "Stripe webhook is not configured");
  const signature = req.get("stripe-signature"); if (!signature || !Buffer.isBuffer(req.body)) return fail(res, 400, "INVALID_WEBHOOK", "Stripe signature and raw request body are required");
  let event: Stripe.Event; try { event = stripeWebhookVerifier.webhooks.constructEvent(req.body.toString("utf8"), signature, webhookSecret); } catch { req.log?.warn({ event: "stripe_webhook_signature_rejected" }, "Stripe webhook signature verification failed"); return fail(res, 400, "INVALID_WEBHOOK_SIGNATURE", "Stripe signature verification failed"); }
  if (process.env.NODE_ENV === "production" && !event.livemode) return fail(res, 400, "INVALID_WEBHOOK_MODE", "Test-mode Stripe events are not accepted in production");
  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session.metadata?.orderId;
  if (!orderId || !["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"].includes(event.type)) return res.json({ received: true });
  const result = await processStripeCheckoutEvent(event, session, orderId);
  if (result === "session-mismatch") req.log?.error({ orderId, eventId: event.id }, "Stripe event does not match the persisted checkout session");
  return res.json({ received: true });
}));

router.get("/payments/:id", ...buyer, safe(async (req, res) => { const payment = await prisma.payment.findFirst({ where: { id: routeParam(req, "id"), order: { OR: [{ buyerId: req.auth!.userId }, { seller: { userId: req.auth!.userId } }] } }, include: { order: true } }); if (!payment) return fail(res, 404, "PAYMENT_NOT_FOUND", "Payment not found"); return res.json({ payment }); }));

router.get("/orders", ...buyer, safe(async (req, res) => res.json({ orders: await prisma.order.findMany({ where: { buyerId: req.auth!.userId }, include: { items: true, payment: true }, orderBy: { createdAt: "desc" } }) })));
router.get("/orders/:id", ...buyer, safe(async (req, res) => { const order = await prisma.order.findFirst({ where: { id: routeParam(req, "id"), buyerId: req.auth!.userId }, include: { items: true, payment: true } }); if (!order) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found"); return res.json({ order }); }));
router.get("/seller/orders", ...seller, safe(async (req, res) => res.json({ orders: await prisma.order.findMany({ where: { seller: { userId: req.auth!.userId } }, include: { items: true, buyer: { select: { id: true, email: true } }, payment: true }, orderBy: { createdAt: "desc" } }) })));
router.get("/seller/orders/:id", ...seller, safe(async (req, res) => { const order = await prisma.order.findFirst({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId } }, include: { items: true, payment: true, buyer: { select: { id: true, email: true } } } }); if (!order) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found"); return res.json({ order }); }));
router.patch("/seller/orders/:id/status", ...seller, safe(async (req, res) => { const input = z.object({ status: z.enum(["PROCESSING", "SHIPPED", "DELIVERED"]) }).safeParse(req.body); if (!input.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid fulfillment status"); const order = await prisma.order.findFirst({ where: { id: routeParam(req, "id"), seller: { userId: req.auth!.userId } } }); if (!order) return fail(res, 404, "ORDER_NOT_FOUND", "Order not found"); const allowed: Record<string, string[]> = { PAID: ["PROCESSING"], PROCESSING: ["SHIPPED"], SHIPPED: ["DELIVERED"] }; if (!allowed[order.status]?.includes(input.data.status)) return fail(res, 409, "INVALID_ORDER_TRANSITION", "Order status transition is not allowed"); const changed = await prisma.order.updateMany({ where: { id: order.id, status: order.status }, data: { status: input.data.status } }); if (!changed.count) return fail(res, 409, "INVALID_ORDER_TRANSITION", "Order status changed concurrently; reload and retry"); return res.json({ order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }) }); }));

router.get("/admin/users", ...admin, safe(async (_req, res) => res.json({ users: await prisma.user.findMany({ select: { id: true, email: true, role: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 100 }) })));
router.get("/admin/orders", ...admin, safe(async (_req, res) => res.json({ orders: await prisma.order.findMany({ include: { items: true, payment: true }, orderBy: { createdAt: "desc" }, take: 100 }) })));

return router;
}

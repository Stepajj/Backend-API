import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import request from "supertest";

const databaseUrl = process.env.REGEAR_TEST_DATABASE_URL;

test("database-backed marketplace workflow and inventory race", { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = "test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_regear_integration_test";
  process.env.LOG_LEVEL = "silent";

  const [{ createApp }, { PrismaClient }, { default: Stripe }] = await Promise.all([
    import("../../dist/app.js"),
    import("@prisma/client"),
    import("stripe")
  ]);
  const testSessions = new Map();
  const testPaymentGateway = {
    async createCheckoutSession(input) {
      if (!testSessions.has(input.idempotencyKey)) {
        const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
        testSessions.set(input.idempotencyKey, { id, url: `https://checkout.test.invalid/${id}?order=${input.orderId}` });
      }
      return testSessions.get(input.idempotencyKey);
    },
    async expireCheckoutSession() {}
  };
  const app = createApp({ paymentGateway: testPaymentGateway });
  const prisma = new PrismaClient();
  await prisma.$connect();
  const readiness = await request(app).get("/health/ready");
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.body, { status: "ready", dependencies: { database: "ok" } });

  const runId = randomUUID();
  const email = suffix => `regear-${runId}-${suffix}@example.test`;
  const password = "Portfolio-test-password-2026";
  const testEmails = [email("buyer"), email("second-buyer")];
  const createdProductIds = [];
  let rejectedCategoryId;
  const stripe = new Stripe("sk_test_regear_integration");
  const response = async (promise, status) => {
    const result = await promise;
    assert.equal(result.status, status, `${result.request?.method} ${result.request?.url}: ${JSON.stringify(result.body)}`);
    return result;
  };
  const register = async address => {
    await response(request(app).post("/api/v1/auth/register").send({ email: address, password }), 201);
    return response(request(app).post("/api/v1/auth/login").send({ email: address, password }), 200);
  };
  const sendEvent = async (eventId, type, checkoutSession, paymentStatus) => {
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      api_version: "2025-02-24.acacia",
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...checkoutSession, payment_status: paymentStatus } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    assert.equal(stripe.webhooks.constructEvent(Buffer.from(payload), signature, process.env.STRIPE_WEBHOOK_SECRET).id, eventId);
    return request(app).post("/api/v1/payments/stripe/webhook").set("Content-Type", "application/json").set("stripe-signature", signature).send(payload);
  };

  let fixtureBuyerIds = [];
  try {
    const adminLogin = await response(request(app).post("/api/v1/auth/login").send({ email: "admin@regear.dev", password: process.env.DEMO_PASSWORD ?? "ReGear-Local-Only-2026!" }), 200);
    const adminToken = adminLogin.body.accessToken;
    const initialBuyerLogin = await register(testEmails[0]);
    assert.ok(initialBuyerLogin.headers["set-cookie"].some(cookie => cookie.startsWith("refreshToken=")));
    await response(request(app).post("/api/v1/auth/register").send({ email: testEmails[0], password }), 409);
    await response(request(app).post("/api/v1/auth/login").send({ email: testEmails[0], password: "wrong-password" }), 401);
    const buyerRecord = await prisma.user.findUniqueOrThrow({ where: { email: testEmails[0] } });
    fixtureBuyerIds.push(buyerRecord.id);
    await response(request(app).post("/api/v1/auth/register").send({ email: email("admin-self-assign"), password, role: "ADMIN" }), 400);
    const oldRefreshCookie = initialBuyerLogin.headers["set-cookie"].find(cookie => cookie.startsWith("refreshToken=")).split(";")[0];
    const rotationAttempts = await Promise.all([0, 1].map(() => request(app).post("/api/v1/auth/refresh").set("Cookie", oldRefreshCookie)));
    assert.ok(rotationAttempts.every(result => [200, 401].includes(result.status)));
    assert.ok(rotationAttempts.some(result => result.status === 401));
    assert.ok(rotationAttempts.filter(result => result.status === 200).length <= 1);
    const rotated = rotationAttempts.find(result => result.status === 200);
    if (rotated) {
      const rotatedCookie = rotated.headers["set-cookie"].find(cookie => cookie.startsWith("refreshToken=")).split(";")[0];
      await response(request(app).post("/api/v1/auth/refresh").set("Cookie", rotatedCookie), 401);
    }
    const initialFamilyTokens = await prisma.refreshToken.findMany({ where: { userId: buyerRecord.id } });
    assert.ok(initialFamilyTokens.length >= 1);
    assert.ok(initialFamilyTokens.every(token => token.revokedAt !== null));
    const buyerLogin = await response(request(app).post("/api/v1/auth/login").send({ email: testEmails[0], password }), 200);
    const buyerToken = buyerLogin.body.accessToken;
    await response(request(app).get("/api/v1/seller/shop"), 401);
    await response(request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${buyerToken}`), 403);
    const expiringLogin = await response(request(app).post("/api/v1/auth/login").send({ email: testEmails[0], password }), 200);
    const expiringCookie = expiringLogin.headers["set-cookie"].find(cookie => cookie.startsWith("refreshToken=")).split(";")[0];
    await prisma.refreshToken.updateMany({ where: { userId: buyerRecord.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await response(request(app).post("/api/v1/auth/refresh").set("Cookie", expiringCookie), 401);
    const paymentsDisabledApp = createApp({ paymentGateway: null });
    await response(request(paymentsDisabledApp).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `unconfigured-${runId}`), 503);
    await response(request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${buyerToken}`), 200);
    await response(request(app).patch("/api/v1/auth/me").set("Authorization", `Bearer ${buyerToken}`).send({ name: "Portfolio Buyer" }), 200);
    await response(request(app).get("/api/auth/me").set("Authorization", `Bearer ${buyerToken}`), 200);

    await response(request(app).post("/api/v1/seller/applications").set("Authorization", `Bearer ${buyerToken}`).send({ businessName: "Portfolio Test Seller", description: "Integration test" }), 201);
    await response(request(app).post("/api/v1/seller/applications").set("Authorization", `Bearer ${buyerToken}`).send({ businessName: "Duplicate Application" }), 409);
    const pendingApplications = await response(request(app).get("/api/v1/admin/seller-applications").set("Authorization", `Bearer ${adminToken}`), 200);
    const applicationId = pendingApplications.body.applications.find(row => row.user.id === buyerRecord.id)?.id;
    assert.ok(applicationId);
    await response(request(app).patch(`/api/v1/admin/seller-applications/${applicationId}`).set("Authorization", `Bearer ${buyerToken}`).send({ decision: "APPROVED" }), 403);
    await response(request(app).patch(`/api/v1/admin/seller-applications/${applicationId}`).set("Authorization", `Bearer ${adminToken}`).send({ decision: "APPROVED" }), 200);
    await response(request(app).patch(`/api/v1/admin/seller-applications/${applicationId}`).set("Authorization", `Bearer ${adminToken}`).send({ decision: "APPROVED" }), 409);

    const sellerLogin = await response(request(app).post("/api/v1/auth/login").send({ email: testEmails[0], password }), 200);
    const sellerToken = sellerLogin.body.accessToken;
    await response(request(app).post("/api/v1/seller/shop").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Portfolio Test Shop", description: "Seller test" }), 201);
    await response(request(app).post("/api/v1/seller/shop").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Duplicate Shop" }), 409);
    const ownShop = await response(request(app).get("/api/v1/seller/shop").set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).patch("/api/v1/seller/shop").set("Authorization", `Bearer ${sellerToken}`).send({ description: "Updated seller profile" }), 200);
    await response(request(app).get(`/api/v1/shops/${ownShop.body.shop.id}`), 200);
    const category = await prisma.category.findFirstOrThrow({ where: { slug: "phones", active: true } });
    await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Invalid" }), 400);
    const newCategory = await response(request(app).post("/api/v1/admin/categories").set("Authorization", `Bearer ${adminToken}`).send({ name: `Temp ${runId.slice(0, 8)}`, slug: `temp-${runId}` }), 201);
    rejectedCategoryId = newCategory.body.category.id;
    await response(request(app).patch(`/api/v1/admin/categories/${rejectedCategoryId}`).set("Authorization", `Bearer ${adminToken}`).send({ name: `Renamed ${runId.slice(0, 8)}` }), 200);
    const created = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Workflow Test Phone", description: "A sufficiently detailed test product", priceCents: 12000, categoryId: category.id, condition: "GOOD", quantity: 3 }), 201);
    const productId = created.body.product.id;
    createdProductIds.push(productId);
    await response(request(app).get("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).get(`/api/v1/seller/products/${productId}`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).get(`/api/v1/products/${productId}`), 404);
    await response(request(app).patch(`/api/v1/seller/products/${productId}`).set("Authorization", `Bearer ${sellerToken}`).send({ quantity: 3 }), 200);
    await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("image", Buffer.from("not a PNG"), { filename: "invalid.png", contentType: "image/png" }), 400);
    await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("unexpected", Buffer.from("x"), { filename: "wrong-field.png", contentType: "image/png" }), 400);
    await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "oversized.png", contentType: "image/png" }), 413);
    const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=", "base64");
    const uploaded = await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("image", tinyPng, { filename: "valid.png", contentType: "image/png" }), 201);
    assert.equal((await response(request(app).get(uploaded.body.image.path), 200)).headers["content-type"], "image/png");
    for (let index = 0; index < 9; index += 1) {
      await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("image", tinyPng, { filename: `valid-${index}.png`, contentType: "image/png" }), 201);
    }
    await response(request(app).post(`/api/v1/seller/products/${productId}/images`).set("Authorization", `Bearer ${sellerToken}`).attach("image", tinyPng, { filename: "too-many.png", contentType: "image/png" }), 409);
    await response(request(app).post(`/api/v1/seller/products/${productId}/submit`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).post(`/api/v1/seller/products/${productId}/submit`).set("Authorization", `Bearer ${sellerToken}`), 409);
    const pendingProducts = await response(request(app).get("/api/v1/admin/products/pending").set("Authorization", `Bearer ${adminToken}`), 200);
    assert.ok(pendingProducts.body.products.some(row => row.id === productId));
    await response(request(app).post(`/api/v1/admin/products/${productId}/approve`).set("Authorization", `Bearer ${sellerToken}`), 403);
    await response(request(app).post(`/api/v1/admin/products/${productId}/approve`).set("Authorization", `Bearer ${adminToken}`), 200);
    await response(request(app).get("/api/v1/products?page=invalid"), 400);
    await response(request(app).get("/api/v1/products?minPrice=20000&maxPrice=10000"), 400);
    const catalog = await response(request(app).get(`/api/v1/products?q=Workflow%20Test%20Phone&categoryId=${category.id}`), 200);
    assert.equal(catalog.body.products[0].id, productId);
    const pagedCatalog = await response(request(app).get("/api/v1/products?page=1&limit=2"), 200);
    assert.equal(pagedCatalog.body.page, 1);
    assert.equal(pagedCatalog.body.limit, 2);
    await response(request(app).get(`/api/v1/products/${productId}`), 200);

    await response(request(app).get("/api/v1/cart").set("Authorization", `Bearer ${buyerToken}`), 200);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 4 }), 409);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: randomUUID(), quantity: 1 }), 409);
    const cartItem = await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 2 }), 201);
    await response(request(app).patch(`/api/v1/cart/items/${cartItem.body.item.id}`).set("Authorization", `Bearer ${buyerToken}`).send({ quantity: 2 }), 200);
    const sameKeyAttempts = await Promise.all([0, 1].map(() => request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `paid-${runId}`)));
    assert.deepEqual(sameKeyAttempts.map(result => result.status).sort(), [200, 201]);
    const checkout = sameKeyAttempts.find(result => result.status === 201);
    const duplicateCheckout = sameKeyAttempts.find(result => result.status === 200);
    assert.equal(duplicateCheckout.body.orderId, checkout.body.orderId);
    let inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 1);
    assert.equal(inventory.reserved, 2);
    await response(request(app).patch(`/api/v1/seller/orders/${checkout.body.orderId}/status`).set("Authorization", `Bearer ${sellerToken}`).send({ status: "PROCESSING" }), 409);

    const paidSession = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.body.paymentId } });
    let order;
    const paidSessionEvent = { id: paidSession.stripeSessionId, object: "checkout.session", metadata: { orderId: checkout.body.orderId }, payment_intent: `pi_${runId}`, amount_total: 24000, currency: "eur" };
    await response(sendEvent(`evt_wrong_total_${runId}`, "checkout.session.completed", { ...paidSessionEvent, amount_total: 1 }, "paid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.body.orderId } });
    assert.equal(order.status, "PENDING_PAYMENT");
    await response(sendEvent(`evt_wrong_currency_${runId}`, "checkout.session.completed", { ...paidSessionEvent, currency: "usd" }, "paid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.body.orderId } });
    assert.equal(order.status, "PENDING_PAYMENT");
    await response(sendEvent(`evt_wrong_session_${runId}`, "checkout.session.completed", { ...paidSessionEvent, id: "cs_test_wrong_session" }, "paid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.body.orderId } });
    assert.equal(order.status, "PENDING_PAYMENT");
    await response(sendEvent(`evt_async_pending_${runId}`, "checkout.session.completed", paidSessionEvent, "unpaid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.body.orderId } });
    assert.equal(order.status, "PENDING_PAYMENT");
    await response(sendEvent(`evt_async_success_${runId}`, "checkout.session.async_payment_succeeded", paidSessionEvent, "paid"), 200);
    await response(sendEvent(`evt_paid_${runId}`, "checkout.session.completed", paidSessionEvent, "paid"), 200);
    await response(sendEvent(`evt_paid_${runId}`, "checkout.session.completed", paidSessionEvent, "paid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.body.orderId }, include: { payment: true } });
    assert.equal(order.status, "PAID");
    assert.equal(order.payment.status, "SUCCEEDED");
    inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 1);
    assert.equal(inventory.reserved, 0);

    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 1 }), 201);
    const failingPaymentApp = createApp({ paymentGateway: {
      async createCheckoutSession(input) { await testPaymentGateway.createCheckoutSession(input); throw new Error("Simulated lost Stripe response after session creation"); },
      async expireCheckoutSession() {}
    } });
    await response(request(failingPaymentApp).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `failed-session-${runId}`), 503);
    const failedSessionOrder = await prisma.order.findUniqueOrThrow({ where: { buyerId_idempotencyKey: { buyerId: buyerRecord.id, idempotencyKey: `failed-session-${runId}` } }, include: { payment: true } });
    assert.equal(failedSessionOrder.status, "PENDING_PAYMENT");
    assert.equal(failedSessionOrder.payment.status, "PENDING");
    inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 0);
    assert.equal(inventory.reserved, 1);
    const retryCheckout = await response(request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `failed-session-${runId}`), 200);
    assert.equal(retryCheckout.body.orderId, failedSessionOrder.id);
    const recoveredSessionOrder = await prisma.order.findUniqueOrThrow({ where: { id: failedSessionOrder.id }, include: { payment: true } });
    assert.ok(recoveredSessionOrder.payment.checkoutUrl);
    assert.equal(recoveredSessionOrder.payment.stripeSessionId, testSessions.get(`regear:${buyerRecord.id}:failed-session-${runId}`).id);
    const failedEventPayload = { id: recoveredSessionOrder.payment.stripeSessionId, object: "checkout.session", metadata: { orderId: failedSessionOrder.id }, amount_total: 12000, currency: "eur" };
    await response(sendEvent(`evt_retry_expired_${runId}`, "checkout.session.expired", failedEventPayload, "unpaid"), 200);
    const reconciledOrder = await prisma.order.findUniqueOrThrow({ where: { id: failedSessionOrder.id }, include: { payment: true } });
    assert.equal(reconciledOrder.status, "CANCELLED");
    assert.equal(reconciledOrder.payment.status, "EXPIRED");
    inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 1);
    assert.equal(inventory.reserved, 0);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 1 }), 201);
    const earlySession = { id: `cs_test_early_${runId.replaceAll("-", "")}`, object: "checkout.session" };
    let earlyWebhookResponse;
    const earlyWebhookApp = createApp({ paymentGateway: {
      async createCheckoutSession(input) {
        const payload = { ...earlySession, metadata: { orderId: input.orderId }, amount_total: 12000, currency: "eur" };
        earlyWebhookResponse = await sendEvent(`evt_early_${runId}`, "checkout.session.expired", payload, "unpaid");
        return { id: earlySession.id, url: `https://checkout.test.invalid/${earlySession.id}` };
      },
      async expireCheckoutSession() {}
    } });
    const earlyCheckout = await response(request(earlyWebhookApp).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `early-webhook-${runId}`), 201);
    assert.equal(earlyWebhookResponse.status, 200);
    await response(sendEvent(`evt_early_${runId}`, "checkout.session.expired", { ...earlySession, metadata: { orderId: earlyCheckout.body.orderId }, amount_total: 12000, currency: "eur" }, "unpaid"), 200);
    const earlyOrder = await prisma.order.findUniqueOrThrow({ where: { id: earlyCheckout.body.orderId }, include: { payment: true } });
    assert.equal(earlyOrder.status, "CANCELLED");
    assert.equal(earlyOrder.payment.status, "EXPIRED");
    inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 1);
    assert.equal(inventory.reserved, 0);
    await response(request(app).get("/api/v1/orders").set("Authorization", `Bearer ${buyerToken}`), 200);
    await response(request(app).get(`/api/v1/orders/${checkout.body.orderId}`).set("Authorization", `Bearer ${buyerToken}`), 200);
    const payment = await response(request(app).get(`/api/v1/payments/${checkout.body.paymentId}`).set("Authorization", `Bearer ${buyerToken}`), 200);
    assert.equal(payment.body.payment.status, "SUCCEEDED");
    await response(request(app).get("/api/v1/seller/orders").set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).get(`/api/v1/seller/orders/${checkout.body.orderId}`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${adminToken}`), 200);
    await response(request(app).get("/api/v1/admin/orders").set("Authorization", `Bearer ${adminToken}`), 200);
    const concurrentProcessing = await Promise.all([0, 1].map(() => request(app).patch(`/api/v1/seller/orders/${checkout.body.orderId}/status`).set("Authorization", `Bearer ${sellerToken}`).send({ status: "PROCESSING" })));
    assert.deepEqual(concurrentProcessing.map(result => result.status).sort(), [200, 409]);
    await response(request(app).patch(`/api/v1/seller/orders/${checkout.body.orderId}/status`).set("Authorization", `Bearer ${sellerToken}`).send({ status: "SHIPPED" }), 200);
    await response(request(app).patch(`/api/v1/seller/orders/${checkout.body.orderId}/status`).set("Authorization", `Bearer ${sellerToken}`).send({ status: "DELIVERED" }), 200);
    await response(request(app).get("/api/v1/seller/products").set("Authorization", `Bearer ${adminToken}`), 403);

    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 1 }), 201);
    const expiredCheckout = await response(request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `expired-${runId}`), 201);
    const expiredPayment = await prisma.payment.findUniqueOrThrow({ where: { id: expiredCheckout.body.paymentId } });
    const expiryEvent = `evt_expired_${runId}`;
    const expiredPayload = { id: expiredPayment.stripeSessionId, object: "checkout.session", metadata: { orderId: expiredCheckout.body.orderId }, amount_total: 12000, currency: "eur" };
    await response(sendEvent(expiryEvent, "checkout.session.expired", expiredPayload, "unpaid"), 200);
    await response(sendEvent(expiryEvent, "checkout.session.expired", expiredPayload, "unpaid"), 200);
    order = await prisma.order.findUniqueOrThrow({ where: { id: expiredCheckout.body.orderId }, include: { payment: true } });
    assert.equal(order.status, "CANCELLED");
    assert.equal(order.payment.status, "EXPIRED");
    inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    assert.equal(inventory.available, 1);
    assert.equal(inventory.reserved, 0);

    const webhookRaceProduct = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Webhook Race Fixture", description: "Single order webhook transition race", priceCents: 5000, categoryId: category.id, condition: "GOOD", quantity: 1 }), 201);
    createdProductIds.push(webhookRaceProduct.body.product.id);
    await response(request(app).post(`/api/v1/seller/products/${webhookRaceProduct.body.product.id}/submit`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).post(`/api/v1/admin/products/${webhookRaceProduct.body.product.id}/approve`).set("Authorization", `Bearer ${adminToken}`), 200);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: webhookRaceProduct.body.product.id, quantity: 1 }), 201);
    const webhookRaceCheckout = await response(request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `webhook-race-${runId}`), 201);
    const webhookRacePayment = await prisma.payment.findUniqueOrThrow({ where: { id: webhookRaceCheckout.body.paymentId } });
    const webhookRaceSession = { id: webhookRacePayment.stripeSessionId, object: "checkout.session", metadata: { orderId: webhookRaceCheckout.body.orderId }, amount_total: 5000, currency: "eur" };
    const competingWebhookResults = await Promise.all([
      sendEvent(`evt_webhook_paid_${runId}`, "checkout.session.completed", webhookRaceSession, "paid"),
      sendEvent(`evt_webhook_expired_${runId}`, "checkout.session.expired", webhookRaceSession, "unpaid")
    ]);
    assert.deepEqual(competingWebhookResults.map(result => result.status), [200, 200]);
    const webhookRaceOrder = await prisma.order.findUniqueOrThrow({ where: { id: webhookRaceCheckout.body.orderId }, include: { payment: true } });
    const webhookRaceInventory = await prisma.inventory.findUniqueOrThrow({ where: { productId: webhookRaceProduct.body.product.id } });
    assert.ok(["PAID", "CANCELLED"].includes(webhookRaceOrder.status));
    assert.equal(webhookRaceInventory.reserved, 0);
    assert.equal(webhookRaceInventory.available, webhookRaceOrder.status === "PAID" ? 0 : 1);
    assert.equal(webhookRaceOrder.payment.status, webhookRaceOrder.status === "PAID" ? "SUCCEEDED" : "EXPIRED");

    const secondBuyerLogin = await register(testEmails[1]);
    const secondBuyerToken = secondBuyerLogin.body.accessToken;
    const secondBuyer = await prisma.user.findUniqueOrThrow({ where: { email: testEmails[1] } });
    fixtureBuyerIds.push(secondBuyer.id);
    await response(request(app).post("/api/v1/seller/applications").set("Authorization", `Bearer ${secondBuyerToken}`).send({ businessName: "Rejected Applicant" }), 201);
    const rejectedApplication = await prisma.sellerApplication.findUniqueOrThrow({ where: { userId: secondBuyer.id } });
    await response(request(app).patch(`/api/v1/admin/seller-applications/${rejectedApplication.id}`).set("Authorization", `Bearer ${adminToken}`).send({ decision: "REJECTED", reason: "Missing required business details" }), 200);
    await response(request(app).get("/api/v1/seller/shop").set("Authorization", `Bearer ${secondBuyerToken}`), 403);
    const raceProduct = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "One Stock Race Phone", description: "Single unit race condition fixture", priceCents: 5000, categoryId: category.id, condition: "FAIR", quantity: 1 }), 201);
    await response(request(app).post(`/api/v1/seller/products/${raceProduct.body.product.id}/submit`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).post(`/api/v1/admin/products/${raceProduct.body.product.id}/approve`).set("Authorization", `Bearer ${adminToken}`), 200);
    createdProductIds.push(raceProduct.body.product.id);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: raceProduct.body.product.id, quantity: 1 }), 201);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${secondBuyerToken}`).send({ productId: raceProduct.body.product.id, quantity: 1 }), 201);
    const raced = await Promise.all([
      request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `race-a-${runId}`),
      request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${secondBuyerToken}`).set("Idempotency-Key", `race-b-${runId}`)
    ]);
    assert.deepEqual(raced.map(result => result.status).sort(), [201, 409]);
    const raceInventory = await prisma.inventory.findUniqueOrThrow({ where: { productId: raceProduct.body.product.id } });
    assert.equal(raceInventory.available, 0);
    assert.equal(raceInventory.reserved, 1);
    const winnerIndex = raced.findIndex(result => result.status === 201);
    const winnerOrderId = raced[winnerIndex].body.orderId;
    const otherBuyerToken = winnerIndex === 0 ? secondBuyerToken : buyerToken;
    await response(request(app).get(`/api/v1/orders/${winnerOrderId}`).set("Authorization", `Bearer ${otherBuyerToken}`), 404);

    const rejectedProduct = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Rejected Fixture", description: "Product for rejection workflow", priceCents: 4000, categoryId: category.id, condition: "FAIR", quantity: 1 }), 201);
    createdProductIds.push(rejectedProduct.body.product.id);
    await response(request(app).post(`/api/v1/seller/products/${rejectedProduct.body.product.id}/submit`).set("Authorization", `Bearer ${sellerToken}`), 200);
    await response(request(app).post(`/api/v1/admin/products/${rejectedProduct.body.product.id}/reject`).set("Authorization", `Bearer ${adminToken}`).send({ reason: "Product description needs more detail" }), 200);
    await response(request(app).get(`/api/v1/products/${rejectedProduct.body.product.id}`), 404);

    const archivedProduct = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${sellerToken}`).send({ name: "Archived Fixture", description: "Product for archive workflow", priceCents: 3500, categoryId: category.id, condition: "FAIR", quantity: 1 }), 201);
    createdProductIds.push(archivedProduct.body.product.id);
    await response(request(app).delete(`/api/v1/seller/products/${archivedProduct.body.product.id}`).set("Authorization", `Bearer ${sellerToken}`), 204);
    const archivedDetails = await response(request(app).get(`/api/v1/seller/products/${archivedProduct.body.product.id}`).set("Authorization", `Bearer ${sellerToken}`), 200);
    assert.equal(archivedDetails.body.product.status, "ARCHIVED");
    await response(request(app).get(`/api/v1/products/${archivedProduct.body.product.id}`), 404);

    const otherSellerLogin = await response(request(app).post("/api/v1/auth/login").send({ email: "seller@regear.dev", password: process.env.DEMO_PASSWORD ?? "ReGear-Local-Only-2026!" }), 200);
    await response(request(app).get(`/api/v1/seller/products/${productId}`).set("Authorization", `Bearer ${otherSellerLogin.body.accessToken}`), 404);
    const otherSellerProduct = await response(request(app).post("/api/v1/seller/products").set("Authorization", `Bearer ${otherSellerLogin.body.accessToken}`).send({ name: `Other Seller ${runId.slice(0, 8)}`, description: "Cross-seller cart validation fixture", priceCents: 4500, categoryId: category.id, condition: "GOOD", quantity: 1 }), 201);
    createdProductIds.push(otherSellerProduct.body.product.id);
    await response(request(app).post(`/api/v1/seller/products/${otherSellerProduct.body.product.id}/submit`).set("Authorization", `Bearer ${otherSellerLogin.body.accessToken}`), 200);
    await response(request(app).post(`/api/v1/admin/products/${otherSellerProduct.body.product.id}/approve`).set("Authorization", `Bearer ${adminToken}`), 200);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId, quantity: 1 }), 201);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: otherSellerProduct.body.product.id, quantity: 1 }), 201);
    await response(request(app).post("/api/v1/checkout").set("Authorization", `Bearer ${buyerToken}`).set("Idempotency-Key", `multi-${runId}`), 400);
    await response(request(app).delete("/api/v1/cart").set("Authorization", `Bearer ${buyerToken}`), 204);
    const clearedCart = await response(request(app).get("/api/v1/cart").set("Authorization", `Bearer ${buyerToken}`), 200);
    assert.equal(clearedCart.body.cart.items.length, 0);

    await response(request(app).patch(`/api/v1/seller/products/${productId}`).set("Authorization", `Bearer ${sellerToken}`).send({ priceCents: 12500 }), 200);
    await response(request(app).get(`/api/v1/products/${productId}`), 404);
    const updatedProduct = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    assert.equal(updatedProduct.status, "PENDING_MODERATION");
    await response(request(app).patch(`/api/v1/seller/products/${productId}`).set("Authorization", `Bearer ${sellerToken}`).send({ description: "Updated details while awaiting review" }), 200);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).status, "PENDING_MODERATION");
    await response(request(app).post(`/api/v1/admin/products/${productId}/approve`).set("Authorization", `Bearer ${adminToken}`), 200);

    const cartForRemoval = await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: otherSellerProduct.body.product.id, quantity: 1 }), 201);
    await response(request(app).delete(`/api/v1/cart/items/${cartForRemoval.body.item.id}`).set("Authorization", `Bearer ${buyerToken}`), 204);
    await response(request(app).post("/api/v1/cart/items").set("Authorization", `Bearer ${buyerToken}`).send({ productId: otherSellerProduct.body.product.id, quantity: 1 }), 201);
    await response(request(app).delete("/api/v1/cart").set("Authorization", `Bearer ${buyerToken}`), 204);

    await response(request(app).patch(`/api/v1/admin/categories/${rejectedCategoryId}`).set("Authorization", `Bearer ${adminToken}`).send({ active: false }), 200);
    const categories = await response(request(app).get("/api/v1/categories"), 200);
    assert.ok(!categories.body.categories.some(row => row.id === rejectedCategoryId));

    const loggedOutCookie = secondBuyerLogin.headers["set-cookie"].find(cookie => cookie.startsWith("refreshToken=")).split(";")[0];
    await response(request(app).post("/api/v1/auth/logout").set("Cookie", loggedOutCookie), 204);
    await response(request(app).post("/api/v1/auth/refresh").set("Cookie", loggedOutCookie), 401);

    await prisma.user.update({ where: { id: buyerRecord.id }, data: { status: "SUSPENDED" } });
    await response(request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${buyerToken}`), 401);
    await response(request(app).post("/api/v1/auth/login").send({ email: testEmails[0], password }), 401);

    const invalidSignature = await request(app).post("/api/v1/payments/stripe/webhook").set("Content-Type", "application/json").set("stripe-signature", "bad").send("{}");
    assert.equal(invalidSignature.status, 400);
  } finally {
    await prisma.webhookEvent.deleteMany({ where: { id: { contains: runId } } });
    await prisma.payment.deleteMany({ where: { order: { buyerId: { in: fixtureBuyerIds } } } });
    await prisma.order.deleteMany({ where: { buyerId: { in: fixtureBuyerIds } } });
    await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: fixtureBuyerIds } } } });
    const sellerProfiles = await prisma.sellerProfile.findMany({ where: { userId: { in: fixtureBuyerIds } }, select: { id: true } });
    const sellerIds = sellerProfiles.map(profile => profile.id);
    const images = await prisma.productImage.findMany({ where: { product: { sellerId: { in: sellerIds } } }, select: { path: true } });
    await Promise.all(images.map(image => unlink(path.resolve("uploads", path.basename(image.path))).catch(() => undefined)));
    await prisma.productImage.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.shop.deleteMany({ where: { sellerId: { in: sellerIds } } });
    if (rejectedCategoryId) await prisma.category.deleteMany({ where: { id: rejectedCategoryId } });
    await prisma.user.deleteMany({ where: { id: { in: fixtureBuyerIds } } });
    await prisma.$disconnect();
  }
});

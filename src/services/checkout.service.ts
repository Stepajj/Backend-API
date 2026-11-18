import type Stripe from "stripe";
import { prisma } from "../infrastructure/database/prisma.js";

export interface CheckoutLineSnapshot {
  productId: string;
  name: string;
  unitAmount: number;
  quantity: number;
}

export interface CheckoutReservation {
  order: { id: string };
  cartId: string;
  items: CheckoutLineSnapshot[];
}

export async function reserveCartForCheckout(buyerId: string, idempotencyKey: string): Promise<CheckoutReservation> {
  return prisma.$transaction(async tx => {
    const cartReference = await tx.cart.findUnique({ where: { userId: buyerId }, select: { id: true } });
    if (!cartReference) throw Object.assign(new Error("Your cart is empty"), { status: 400, code: "CART_EMPTY" });
    await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cartReference.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "CartItem" WHERE "cartId" = ${cartReference.id} ORDER BY "id" FOR UPDATE`;
    const initialItems = await tx.cartItem.findMany({ where: { cartId: cartReference.id }, select: { productId: true } });
    if (!initialItems.length) throw Object.assign(new Error("Your cart is empty"), { status: 400, code: "CART_EMPTY" });
    if (initialItems.length > 50) throw Object.assign(new Error("A checkout can contain no more than 50 products"), { status: 400, code: "CART_TOO_LARGE" });

    // Lock catalog rows consistently so price/status and inventory cannot change mid-checkout.
    for (const productId of initialItems.map(item => item.productId).sort()) {
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    }
    const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartReference.id }, include: { items: { include: { product: { include: { inventory: true } } } } } });
    if (!cart.items.length) throw Object.assign(new Error("Your cart is empty"), { status: 400, code: "CART_EMPTY" });
    const sellerIds = new Set(cart.items.map(item => item.product.sellerId));
    if (sellerIds.size !== 1) throw Object.assign(new Error("Checkout supports products from one seller at a time"), { status: 400, code: "MULTI_SELLER_CART" });

    let totalCents = 0;
    for (const item of cart.items) {
      if (!item.product.inventory || item.product.inventory.available < item.quantity || item.product.status !== "APPROVED") {
        throw Object.assign(new Error(`Insufficient stock for ${item.product.name}`), { status: 409, code: "INSUFFICIENT_INVENTORY" });
      }
      const changed = await tx.inventory.updateMany({
        where: { productId: item.productId, available: { gte: item.quantity } },
        data: { available: { decrement: item.quantity }, reserved: { increment: item.quantity } }
      });
      if (changed.count !== 1) throw Object.assign(new Error(`Insufficient stock for ${item.product.name}`), { status: 409, code: "INSUFFICIENT_INVENTORY" });
      totalCents += item.product.priceCents * item.quantity;
      if (!Number.isSafeInteger(totalCents) || totalCents > 2_147_483_647) {
        throw Object.assign(new Error("Order total exceeds the supported maximum"), { status: 400, code: "ORDER_TOTAL_TOO_LARGE" });
      }
    }

    const order = await tx.order.create({
      data: {
        buyerId,
        sellerId: [...sellerIds][0]!,
        idempotencyKey,
        totalCents,
        items: { create: cart.items.map(item => ({ productId: item.productId, productName: item.product.name, unitPriceCents: item.product.priceCents, quantity: item.quantity })) }
      }
    });
    await tx.payment.create({ data: { orderId: order.id } });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return {
      order: { id: order.id },
      cartId: cart.id,
      items: cart.items.map(item => ({ productId: item.productId, name: item.product.name, unitAmount: item.product.priceCents, quantity: item.quantity }))
    };
  });
}

export async function releaseCheckoutReservation(reservation: CheckoutReservation): Promise<void> {
  await prisma.$transaction(async tx => {
    const released = await tx.order.updateMany({
      where: { id: reservation.order.id, status: "PENDING_PAYMENT", reservationReleasedAt: null },
      data: { status: "CANCELLED", reservationReleasedAt: new Date() }
    });
    if (released.count !== 1) return;
    for (const item of reservation.items) {
      await tx.inventory.update({ where: { productId: item.productId }, data: { available: { increment: item.quantity }, reserved: { decrement: item.quantity } } });
    }
    await tx.payment.update({ where: { orderId: reservation.order.id }, data: { status: "FAILED" } });
    await tx.cartItem.createMany({ data: reservation.items.map(item => ({ cartId: reservation.cartId, productId: item.productId, quantity: item.quantity })), skipDuplicates: true });
  });
}

export type StripeEventResult = "unknown-order" | "session-pending" | "session-mismatch" | "duplicate" | "already-final" | "awaiting-payment" | "processed";

export async function processStripeCheckoutEvent(event: Stripe.Event, session: Stripe.Checkout.Session, orderId: string): Promise<StripeEventResult> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true, payment: true } });
    if (!order) return "unknown-order";
    if (!order.payment) return "session-pending";
    if (session.amount_total !== order.totalCents || session.currency !== order.currency) return "session-mismatch";
    if (order.payment.stripeSessionId && order.payment.stripeSessionId !== session.id) return "session-mismatch";
    if (!order.payment.stripeSessionId) {
      await tx.payment.update({ where: { id: order.payment.id }, data: { stripeSessionId: session.id, ...(session.url ? { checkoutUrl: session.url } : {}) } });
    }

    const inserted = await tx.webhookEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true });
    if (!inserted.count) return "duplicate";
    if (order.reservationReleasedAt || order.status !== "PENDING_PAYMENT") return "already-final";

    const isCompletion = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
    if (isCompletion && session.payment_status !== "paid") return "awaiting-payment";
    if (isCompletion) {
      const transitioned = await tx.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT", reservationReleasedAt: null }, data: { status: "PAID" } });
      if (transitioned.count !== 1) return "already-final";
      await tx.payment.update({ where: { id: order.payment.id }, data: { status: "SUCCEEDED", stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null } });
      for (const item of order.items) await tx.inventory.update({ where: { productId: item.productId }, data: { reserved: { decrement: item.quantity } } });
      return "processed";
    }

    const transitioned = await tx.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT", reservationReleasedAt: null }, data: { status: "CANCELLED", reservationReleasedAt: new Date() } });
    if (transitioned.count !== 1) return "already-final";
    await tx.payment.update({ where: { id: order.payment.id }, data: { status: event.type.endsWith("expired") ? "EXPIRED" : "FAILED" } });
    for (const item of order.items) await tx.inventory.update({ where: { productId: item.productId }, data: { available: { increment: item.quantity }, reserved: { decrement: item.quantity } } });
    return "processed";
  });
}

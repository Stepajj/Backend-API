-- Database-level invariants complement API validation and protect non-HTTP writes.
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_priceCents_positive" CHECK ("priceCents" > 0);
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_totalCents_positive" CHECK ("totalCents" > 0);
ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_unitPriceCents_positive" CHECK ("unitPriceCents" > 0);

-- These foreign-key columns are used for relation lookups and cascade operations.
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();
async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seed accounts are disabled in production");
  const demoPassword = process.env.DEMO_PASSWORD ?? "ReGear-Local-Only-2026!";
  if (demoPassword.length < 12) throw new Error("DEMO_PASSWORD must contain at least 12 characters");
  const passwordHash = await argon2.hash(demoPassword);
  const admin = await prisma.user.upsert({ where: { email: "admin@regear.dev" }, update: { role: "ADMIN", passwordHash }, create: { email: "admin@regear.dev", passwordHash, role: "ADMIN" } });
  const seller = await prisma.user.upsert({ where: { email: "seller@regear.dev" }, update: { role: "SELLER", passwordHash }, create: { email: "seller@regear.dev", passwordHash, role: "SELLER" } });
  await prisma.user.upsert({ where: { email: "buyer@regear.dev" }, update: { passwordHash }, create: { email: "buyer@regear.dev", passwordHash } });
  const profile = await prisma.sellerProfile.upsert({ where: { userId: seller.id }, update: {}, create: { userId: seller.id } });
  await prisma.shop.upsert({ where: { sellerId: profile.id }, update: {}, create: { sellerId: profile.id, name: "ReGear Demo Shop", description: "Demo refurbished electronics" } });
  const phones = await prisma.category.upsert({ where: { slug: "phones" }, update: { active: true }, create: { name: "Phones", slug: "phones" } });
  const laptops = await prisma.category.upsert({ where: { slug: "laptops" }, update: { active: true }, create: { name: "Laptops", slug: "laptops" } });
  for (const [name, categoryId, priceCents] of [["Refurbished smartphone", phones.id, 29900], ["Used business laptop", laptops.id, 54900]] as const) {
    const product = await prisma.product.findFirst({ where: { name, sellerId: profile.id } });
    if (!product) await prisma.product.create({ data: { sellerId: profile.id, categoryId, name, description: "Demo item in good condition", priceCents, condition: "GOOD", status: "APPROVED", inventory: { create: { available: 5 } } } });
  }
  console.info(`Seeded local demo accounts: admin=${admin.email}, seller=seller@regear.dev, buyer=buyer@regear.dev`);
}
main().catch(error => { console.error("Database seed failed", error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });

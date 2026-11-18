# Implemented endpoint inventory and coverage

This inventory is based on current Express route registrations in `src/app.ts`, `src/routes/auth.routes.ts`, `src/routes/health.routes.ts` and `src/routes/marketplace.routes.ts`. OpenAPI JSON is served at `GET /api/v1/openapi.json`; interactive Swagger UI is served at `/api/v1/docs/`.

There are 37 marketplace method registrations, 6 authentication handlers mounted under both `/api/auth` and `/api/v1/auth`, 2 health handlers, one OpenAPI JSON endpoint and one Swagger UI endpoint (53 documented operations, counting auth aliases separately). `/health` and `/health/` both match the liveness route because Express ignores a trailing slash by default.

## Health and docs

| Method | Path | Access | Automated coverage |
|---|---|---|---|
| GET | `/health/` (`/health` alias) | Public liveness | `smoke.test.js`: status and response |
| GET | `/health/ready` | Public; checks PostgreSQL | `marketplace-workflow.test.js`: ready with database |
| GET | `/api/v1/openapi.json` | Public | `smoke.test.js`: JSON, title, checkout operation |
| GET | `/api/v1/docs/` | Public | Manually exercised against running server; HTML 200 |

## Authentication

Every handler below is mounted at both `/api/auth` and `/api/v1/auth`.

| Method | Path suffix | Access | Automated coverage |
|---|---|---|---|
| POST | `/register` | Public, rate limited | Full workflow: registration, duplicate email, forbidden role assignment |
| POST | `/login` | Public, rate limited | Full workflow: success, invalid password, suspended user |
| POST | `/refresh` | Refresh cookie | Full workflow: concurrent rotation, reuse/family revocation, expiry, logout revocation |
| POST | `/logout` | Refresh cookie | Full workflow: logout and rejected reuse |
| GET | `/me` | Access JWT | Full workflow on v1 and legacy prefixes; suspended account rejected |
| PATCH | `/me` | Access JWT | Full workflow: profile update |

## Seller onboarding and shops

| Method | Path | Access | Automated coverage |
|---|---|---|---|
| POST | `/api/v1/seller/applications` | Buyer | Full workflow: create, duplicate conflict |
| GET | `/api/v1/admin/seller-applications` | Admin | Full workflow: pending application list |
| PATCH | `/api/v1/admin/seller-applications/:id` | Admin | Full workflow: wrong-role denial, approval, duplicate review conflict, rejection by second buyer |
| POST | `/api/v1/seller/shop` | Seller | Full workflow: create and duplicate conflict |
| GET | `/api/v1/seller/shop` | Seller | Full workflow: own shop |
| PATCH | `/api/v1/seller/shop` | Seller | Full workflow: update |
| GET | `/api/v1/shops/:id` | Public | Full workflow: public shop details |

## Catalog and moderation

| Method | Path | Access | Automated coverage |
|---|---|---|---|
| GET | `/api/v1/categories` | Public | Full workflow: active list and deactivated-category visibility |
| POST | `/api/v1/admin/categories` | Admin | Full workflow: category creation |
| PATCH | `/api/v1/admin/categories/:id` | Admin | Full workflow: rename and deactivate |
| POST | `/api/v1/seller/products` | Seller | Full workflow: create and invalid body |
| GET | `/api/v1/seller/products` | Seller | Full workflow: own listing |
| GET | `/api/v1/seller/products/:id` | Owning seller | Full workflow: own and cross-seller access |
| PATCH | `/api/v1/seller/products/:id` | Owning seller | Full workflow: update, approved-product re-moderation and update while pending |
| DELETE | `/api/v1/seller/products/:id` | Owning seller | Full workflow: archive and public invisibility |
| POST | `/api/v1/seller/products/:id/images` | Owning seller | Full workflow: invalid bytes, unexpected field, >5 MB and >10 images rejected, PNG upload and served content type |
| POST | `/api/v1/seller/products/:id/submit` | Owning seller | Full workflow: submit and duplicate-state conflict |
| GET | `/api/v1/products` | Public | Full workflow: search, category, pagination, malformed page and invalid price range |
| GET | `/api/v1/products/:id` | Public | Full workflow: approved visible; rejected/archived hidden |
| GET | `/api/v1/admin/products/pending` | Admin | Full workflow: pending listing |
| POST | `/api/v1/admin/products/:id/approve` | Admin | Full workflow: wrong-role denial and approval |
| POST | `/api/v1/admin/products/:id/reject` | Admin | Full workflow: rejection and public invisibility |

## Cart, checkout and payments

| Method | Path | Access | Automated coverage |
|---|---|---|---|
| GET | `/api/v1/cart` | Authenticated buyer/seller/admin | Full workflow: cart read |
| POST | `/api/v1/cart/items` | Authenticated buyer/seller/admin | Full workflow: add, insufficient/unknown product, cross-seller setup |
| PATCH | `/api/v1/cart/items/:id` | Cart owner | Full workflow: quantity update |
| DELETE | `/api/v1/cart/items/:id` | Cart owner | Full workflow: remove item |
| DELETE | `/api/v1/cart` | Cart owner | Full workflow: clear and verify empty |
| POST | `/api/v1/checkout` | Authenticated; Stripe configured; `Idempotency-Key` | Full workflow: Stripe unavailable response, concurrent same-key requests, mixed seller, inventory race, failed gateway compensation, successful order creation |
| POST | `/api/v1/payments/stripe/webhook` | Valid Stripe signature | Full workflow: invalid signature, success, duplicate, async pending/success, expiry, concurrent event types, mismatched ID/amount/currency |
| GET | `/api/v1/payments/:id` | Order buyer or seller | Full workflow: buyer payment history |

## Orders and administration

| Method | Path | Access | Automated coverage |
|---|---|---|---|
| GET | `/api/v1/orders` | Buyer | Full workflow: buyer history |
| GET | `/api/v1/orders/:id` | Buyer owner | Full workflow: own order; other buyer receives 404 |
| GET | `/api/v1/seller/orders` | Seller | Full workflow: seller list |
| GET | `/api/v1/seller/orders/:id` | Owning seller | Full workflow: seller details |
| PATCH | `/api/v1/seller/orders/:id/status` | Owning seller | Full workflow: unpaid transition rejected, concurrent processing transition (one success/one conflict), shipped, delivered |
| GET | `/api/v1/admin/users` | Admin | Full workflow: admin list |
| GET | `/api/v1/admin/orders` | Admin | Full workflow: admin order list |

## Coverage boundaries

The database-backed test is an end-to-end scenario in one Node test case, not a collection of isolated unit tests. It uses PostgreSQL, the real Express app, Prisma and signed Stripe-shaped webhook fixtures. A test-only gateway is injected through `createApp`; no fake gateway is selected by runtime environment settings.

Not verified against external infrastructure: Stripe Test Mode API calls (no Stripe credentials were provided), Stripe CLI delivery, Docker image/container startup (Docker daemon access is unavailable in this environment), and the compensation path where Stripe session creation succeeds but session persistence and remote expiration both fail. Signed early webhooks, upload size limits and same-key checkout recovery are covered with the isolated test gateway and PostgreSQL. External Stripe/Docker behavior is not claimed as verified.

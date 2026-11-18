# Architecture decisions

## Modular monolith

ReGear is deployed as one API process backed by PostgreSQL. The marketplace MVP has one transactional boundary spanning catalog availability, inventory reservation, orders and payment state, so splitting it into networked services would add failure modes without improving the current product. API routes are grouped under `/api/v1`; authentication also retains its original `/api/auth` paths.

The intended request path is HTTP middleware → route/controller → application service → repository/Prisma → PostgreSQL. Authentication follows this separation most consistently. Checkout reservation/compensation and Stripe webhook state transitions live in `src/services/checkout.service.ts`; some other marketplace route handlers still perform validation and orchestration alongside Prisma calls. Domain-specific repositories for all marketplace reads/writes are intentionally not claimed as complete.

`createApp` and `createMarketplaceRouter` accept the payment gateway as a dependency. The production default is a Stripe-backed gateway or `null` when Stripe is not configured. Test-only gateways are declared in integration tests and are never selected by production environment flags.

## Database invariants

PostgreSQL is the persistence authority. Prisma migrations define relational tables, foreign keys, uniqueness and indexes. SQL check constraints protect positive product/order amounts, positive line quantities and nonnegative inventory even for writes that bypass HTTP validation. Money uses integer minor units (`priceCents`, `totalCents`) to avoid floating-point arithmetic.

Order items preserve the product name, price and quantity at checkout time. Product foreign keys remain for referential integrity and history association. Categories and products are archived/deactivated instead of being deleted when that would break business history.

## Refresh token rotation

The client receives an opaque random refresh token in an HTTP-only, SameSite cookie. Only a SHA-256 hash is stored. Rotation conditionally revokes the active row and inserts its successor in one transaction. Reuse of a rotated/revoked token revokes all remaining active tokens in that family. Access tokens are short-lived JWTs and authorization also checks the current account state and role in PostgreSQL.

## Checkout and inventory

The client submits product IDs and quantities only. In a database transaction, checkout locks the cart and cart items, locks product rows in sorted ID order, reloads the current product and inventory state, and verifies the one-seller rule. It then conditionally decrements `available`, increments `reserved`, writes immutable order-line snapshots and clears the cart. A unique `(buyerId, idempotencyKey)` constraint protects repeated requests; concurrent same-key requests return the existing checkout once its session is persisted.

Checkout Session creation occurs after the database reservation transaction because Stripe is an external system and cannot join a PostgreSQL transaction. A definitive Stripe rejection with no session triggers a compensating transaction that cancels the order, releases the reservation and restores the cart. If the network outcome is ambiguous, the reservation stays in `PENDING_PAYMENT`; retrying with the same key recovers Stripe's idempotent Checkout Session. If a session was created but persistence fails, the application first attempts to expire it; stock stays reserved if expiration cannot be confirmed.

## Payment webhooks

The Stripe route receives the raw request body and verifies the `Stripe-Signature`. It checks the Checkout Session ID, amount and currency against the persisted order before accepting the event. Production accepts only Stripe live-mode events. The event ID has a unique database constraint. Order state changes use conditional updates from `PENDING_PAYMENT`; stock commitment/release happens in the same transaction. Duplicate event IDs and distinct competing event types cannot apply stock movements twice.

When an event reaches the API before the Checkout Session ID is saved, the handler locks the order, checks the signed event's order metadata, amount and currency, then associates the session and processes the event in one transaction. `checkout.session.completed` with an unpaid session remains pending for asynchronous payment events; browser redirects are not trusted as payment confirmation.

## Errors, logging and lifecycle

Express 5 async failures reach the centralized error middleware. Prisma constraint errors map to stable client errors; unexpected errors are logged with a request ID and returned without stack traces. Pino redacts credentials and cookies. Liveness reports process health; readiness checks PostgreSQL. SIGINT/SIGTERM stop accepting HTTP work before disconnecting Prisma.

## Image storage

Uploads use random UUID filenames under the configured `UPLOAD_DIR` (default `uploads/`), enforce a 5 MB file limit and a 10-image product limit, check declared MIME and inspect file signatures. The upload path is generated by the server and ownership is checked before the file is accepted. Incomplete/invalid uploads are removed. Local and single-container Compose deployments persist this directory in a named volume. It is not suitable for multiple API replicas without shared object storage.

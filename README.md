# ReGear API

ReGear is a TypeScript API for a refurbished electronics marketplace. Its MVP covers buyer registration, seller onboarding, product moderation, catalog discovery, carts, checkout, payment confirmation and order fulfillment. PostgreSQL is the source of truth for users, catalog, inventory, orders and payment state.

## Stack and structure

- Node.js 24, TypeScript, Express 5 and Prisma 6.
- PostgreSQL 16, versioned Prisma migrations and relational constraints.
- JWT access tokens plus opaque, rotating refresh tokens stored by SHA-256 hash.
- Stripe Checkout and signature-verified webhook processing.
- Pino structured request/application logs, Helmet, CORS allow-list and rate limits.

The application is a **modular monolith**. HTTP setup lives in `src/app.ts`; routes are grouped by API surface, authentication has controller/service/repository layers, and Prisma is the persistence layer. High-risk checkout reservation/compensation and payment webhook transitions are isolated in a commerce service and guarded with PostgreSQL transactions and conditional updates. Some lower-risk marketplace route handlers still combine HTTP validation and Prisma reads/writes; domain repositories are not claimed for every operation.

See [architecture decisions](docs/architecture.md) for transaction and module details. The complete endpoint inventory and test mapping is [here](docs/endpoint-coverage.md). Swagger UI is served at `/api/v1/docs/`; OpenAPI JSON is at `/api/v1/openapi.json`.

## Local setup

Prerequisites: Node.js 24, npm, Docker Compose (or a reachable PostgreSQL 16 instance), and OpenSSL.

```sh
cp .env.example .env
```

Set `JWT_ACCESS_SECRET` in `.env` to the output of `openssl rand -base64 32`. Set a local `POSTGRES_PASSWORD`, then install and start the database:

```sh
npm ci
docker compose up -d postgres
npx prisma generate
npm run db:migrate
npm run db:seed
npm run dev
```

The server listens on `http://localhost:3000`. Liveness is `GET /health/`; readiness (including PostgreSQL) is `GET /health/ready`. Swagger is available at `http://localhost:3000/api/v1/docs/`.

Stripe is optional for starting the API and using unrelated endpoints. Without a configured secret, checkout responds with `503 PAYMENTS_UNAVAILABLE`. For local payment testing, configure a Stripe **test-mode** secret and webhook signing secret, then run:

```sh
stripe listen --forward-to localhost:3000/api/v1/payments/stripe/webhook
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by Stripe CLI. The application never marks an order paid from a browser redirect; only a verified Stripe event with a matching session, amount and currency can confirm payment.

The seed is an explicit local command and refuses `NODE_ENV=production`. It creates demo admin/seller/buyer accounts with a local-only password; change `DEMO_PASSWORD` before seeding and never use those accounts in a deployed environment.

## Running in containers

For the API and database together, configure `.env` and run:

```sh
docker compose up --build
```

The one-shot migration job waits for PostgreSQL readiness and applies migrations before the API starts. The API image contains production dependencies and runs as a non-root user. PostgreSQL and uploaded images use named local volumes; the API exposes a readiness healthcheck. Port bindings are localhost-only. Docker Compose defaults are for local development, not public production exposure.

## Database and tests

Database schema and migrations are in `prisma/`. Deploy migrations with `npm run db:migrate`; do not use `prisma db push` for shared environments. Integration tests require a separate database with a name ending in `_test`:

```sh
createdb regear_test
REGEAR_TEST_DATABASE_URL='postgresql://regear:password@localhost:5432/regear_test?schema=public' npm test
```

The test guard rejects non-PostgreSQL URLs, databases without the `_test` suffix and the same database endpoint configured as `DATABASE_URL`. Tests apply migrations and seed only that isolated database. `npm run test:smoke` exercises health and OpenAPI without requiring PostgreSQL.

Useful checks:

```sh
npx prisma validate
npx prisma generate
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

## Engineering decisions

- Inventory is reserved in the same PostgreSQL transaction that creates an order. Checkout locks cart rows and product rows in a stable order, then uses conditional inventory updates; competing buyers cannot reserve the last unit twice.
- Checkout prices and order-line snapshots are created from database product state, never client-submitted prices. Buyer-scoped idempotency keys are protected by a unique constraint.
- Refresh tokens are random opaque credentials; only hashes are persisted. Rotation is conditional and transactional. Reuse revokes the token family.
- Stripe webhook events are signature-verified from the raw request body. A unique event ID and conditional order transition make duplicate/concurrent deliveries safe. If a verified event arrives before the Checkout Session ID is saved, matching order metadata, amount and currency let the handler associate and reconcile it transactionally.
- API errors are centralized and do not expose server exception details. Request IDs and structured logs aid diagnosis while credential fields are redacted.

## MVP limitations

- Checkout supports a single seller per order; mixed-seller carts are rejected.
- Product images are stored on the local filesystem in the single-instance deployment. The Compose volume persists them locally; multi-instance deployments need shared object storage.
- Stripe live credentials, production secret management, TLS termination, backups and deployment infrastructure must be supplied by the operator. Docker behavior must be verified on a host with Docker access before deployment.
- Refunds, seller payouts, reviews, email verification and password recovery are outside this MVP.

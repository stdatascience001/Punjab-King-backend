# Punjab King — Backend

This repo contains only the **backend API** (`apps/api`) of the PB Exchange project, split out from the main monorepo, along with the shared packages it depends on: `packages/database` (Drizzle ORM + Postgres), `packages/types` (shared TypeScript DTOs), and `packages/validation` (Zod schemas). No frontend code is included.

## Setup

```bash
cp .env.example .env   # fill in real DATABASE_URL, REDIS_*, JWT_SECRET, etc.
npm install
npm run build           # builds packages/types -> packages/validation -> packages/database -> apps/api
npm run db:migrate       # creates/updates all tables
npm run db:seed          # seeds roles + a default Super Admin user
npm run dev               # start apps/api in watch mode (or `npm start` after build)
```

Requires a running PostgreSQL and Redis instance (see `.env.example` for connection settings).

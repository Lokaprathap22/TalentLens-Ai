# TalentLens AI

TalentLens AI is an explainable recruitment workflow application. It is designed to help
recruiters prioritize candidates using job-related, evidence-backed assessments while keeping
human review and decision-making in the workflow.

This repository currently contains the initial monorepo foundation. Candidate workflows, AI
processing, authentication, and database models are intentionally not implemented yet.

## Stack

- React 19, Vite 8, TypeScript, and Tailwind CSS 4
- Node.js 24, Express 5, and TypeScript
- PostgreSQL infrastructure through Docker Compose
- npm workspaces with a shared Zod schema package
- Vitest, Supertest, ESLint, and Prettier

## Repository structure

```text
apps/
  api/       Express API and health endpoint
  web/       React/Vite development shell
  worker/    Background worker entry point
packages/
  shared/    Shared TypeScript types and Zod schemas
prisma/      Reserved for future Prisma schema and migrations
docs/        Product and technical specification
```

## Prerequisites

- Node.js `>=24.11.0 <25`
- npm 11+
- Docker Desktop for local PostgreSQL

## Installation

```powershell
npm install
Copy-Item .env.example .env
```

The `.env` file is local-only and must not be committed.

## Development

Start the web app, API, and worker together:

```powershell
npm run dev
```

Or start them separately:

```powershell
npm run dev:web
npm run dev:api
npm run dev:worker
```

The web development server proxies `/api` requests to `http://localhost:4000`.

## API health endpoint

With the API running, request:

```text
GET http://localhost:4000/api/v1/health
```

The response is validated against the shared Zod schema and has this shape:

```json
{
  "status": "ok",
  "service": "talentlens-api",
  "timestamp": "2026-11-03T00:00:00.000Z"
}
```

## PostgreSQL

Start the development database only when needed:

```powershell
docker compose up -d db
```

Stop it with:

```powershell
docker compose down
```

The Compose file binds PostgreSQL to localhost and uses development-only fallback values.
Prisma is reserved for a later phase and is not initialized by this foundation.

## Quality checks

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run format:check
```

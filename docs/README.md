# UmansChat Documentation

Contributor documentation for UmansChat — a self-hosted, open-source AI workspace
built with Next.js 16 + React 19 + SQLite.

## Getting Started

- **New to the codebase?** Start with [Architecture Overview](./architecture.md) for the big picture.
- **Setting up locally?** See the [Quick Start section in the main README](../README.md#quick-start-local-dev).
- **Want to contribute?** Read [Contributing Guide](./contributing.md).

## Documentation Index

### Architecture & Core

| Document | Description |
|----------|-------------|
| [Architecture Overview](./architecture.md) | High-level system architecture, service topology, data flow |
| [Database & Schema](./database.md) | SQLite setup, Drizzle ORM, all tables, migrations, indexes |
| [Authentication & User Isolation](./authentication.md) | Auth.js v5, Credentials/Google OAuth, per-user data scoping |
| [API Routes Reference](./api-routes.md) | Every API endpoint with method, purpose, and behavior |

### Chat & LLM

| Document | Description |
|----------|-------------|
| [Chat & Streaming](./chat-streaming.md) | SSE streaming protocol, branching model, dual-model, rapid mode |
| [Tool Calling](./tool-calling.md) | Built-in tools, MCP integration, connections (Notion), tool probe |

### AI Features

| Document | Description |
|----------|-------------|
| [Memory System](./memory.md) | Fact/working memory extraction, RAG retrieval, recency scoring |
| [Skills System](./skills.md) | Skill kinds, RAG matching, auto-extraction, approval pipeline |
| [Personalization](./personalization.md) | Style presets, trait sliders, system prompt injection |
| [Embeddings & Vector Search](./embeddings.md) | Local ONNX vs HTTP embedder, cosine similarity, dimension migration |

### Frontend

| Document | Description |
|----------|-------------|
| [Frontend Components](./frontend.md) | Component catalog, server/client boundaries, UI primitives |
| [Hooks & State](./hooks.md) | useChat, useThreads, useFolders — state management patterns |
| [i18n & Theming](./i18n-theming.md) | Translation dictionaries, CSS variables, dark/light themes |

### Infrastructure

| Document | Description |
|----------|-------------|
| [Settings & Environment](./settings-env.md) | .env configuration, runtime settings GUI, cache invalidation |
| [Deployment](./deployment.md) | Docker, standalone exe, CI/CD, Cloudflare Tunnel |
| [Testing Guide](./testing.md) | Vitest v4 setup, conventions, mocking, DB tests |

### AI Agent Development

| Document | Description |
|----------|-------------|
| [Module Map](./module-map.md) | Module boundaries, safety zones (safe / caution / high-risk) |
| [Glossary](./glossary.md) | Domain terms (thread, branch, leaf, memory, skill, etc.) |
| [API Route Pattern](./patterns/api-route.md) | API route handler pattern with good/bad examples |
| [Component Pattern](./patterns/component.md) | React component pattern with good/bad examples |
| [Test Pattern](./patterns/test.md) | Test writing pattern with good/bad examples |
| [DB Migration Pattern](./patterns/db-migration.md) | Database migration workflow and pitfalls |

## Quick Links

- [Main README (EN)](../README.md)
- [Main README (JA)](../README.ja.md)
- [AGENTS.md](../AGENTS.md) — AI agent rules and project conventions
- [Development Plan (PLAN.md)](../PLAN.md) — historical phase-by-phase implementation log

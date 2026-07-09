Authentication and user data isolation for UmansChat — Auth.js v5 setup, providers, session management, and the per-user data scoping pattern enforced across every API route.

## Relevant source files

- `src/auth.ts` — Auth.js v5 main configuration (providers, callbacks, DrizzleAdapter)
- `src/auth.config.ts` — edge-safe config (authorized callback, used by the proxy)
- `src/proxy.ts` — Next.js 16 proxy (formerly middleware); gates page routes only
- `src/lib/auth-guards.ts` — `getSessionUser()`, the universal API-route auth guard
- `src/lib/password.ts` — bcrypt password hashing/verification
- `src/app/actions/auth.ts` — server actions: `register`, `login`, `authenticate`, `logout`, `signInWithGoogle`
- `src/app/login/page.tsx` — login/registration page (first-run detection)
- `src/db/schema.ts` — `users`, `accounts`, `sessions`, `verification_tokens` table definitions

## Overview

UmansChat authenticates users with **Auth.js v5** (NextAuth v5). Two providers are supported:

1. **Credentials** — email + password (always enabled).
2. **Google OAuth** — conditionally enabled when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

Sessions use a **JWT strategy** (no database session rows). Every API route authenticates independently via `getSessionUser()` and scopes all database queries by `userId`. There is no role-based access control — the first registered user inherits any pre-existing ownerless data, but there is no explicit "admin" role.

## Auth.js v5 setup

### Configuration split

The configuration is split across two files so that the edge-safe proxy can run without importing database modules:

- `src/auth.config.ts` — contains only the `authorized` callback and `pages.signIn`. This is the only file the proxy (`src/proxy.ts`) imports.
- `src/auth.ts` — the full configuration: imports `authConfig`, adds the `DrizzleAdapter`, providers, and the `signIn`/`jwt`/`session` callbacks. This is what the API routes and server actions use.

```ts
// src/auth.config.ts (edge-safe)
export const authConfig = {
  pages: { signIn: "/login" },
  callbacks: {
    authorized: ({ auth, request }) => { /* page-route gating only */ },
  },
  providers: [], // providers are added in auth.ts
} satisfies NextAuthConfig;

// src/auth.ts (full)
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, { usersTable: users }),
  session: { strategy: "jwt" },
  providers: [Credentials({ ... }), ...(googleEnabled ? [Google({ ... })] : [])],
  callbacks: { ...authConfig.callbacks, signIn, jwt, session },
});
```

The split exists because the proxy runs in the Next.js edge runtime, which cannot import the native `better-sqlite3` driver. Keeping `auth.config.ts` free of DB imports lets it execute at the edge; the full `auth.ts` (with DB access) runs only in Node.js server components and route handlers.

### DrizzleAdapter

`DrizzleAdapter` connects Auth.js to the Drizzle-managed SQLite tables. It is configured with the custom `users` table:

```ts
adapter: DrizzleAdapter(db, {
  usersTable: users,
  // accounts is cast because its camelCase property names differ from the
  // adapter's expected snake_case shape. With the JWT strategy, accounts
  // rows are created manually in the signIn callback, so the adapter's
  // account methods (linkAccount, etc.) are never executed at runtime.
}),
```

The `accounts` table is **not** passed to the adapter as a typed table — only `usersTable` is. This is intentional: with the JWT session strategy, Auth.js's `handleLoginOrRegister` flow finds an existing account via `getUserByAccount` and skips `createUser`/`linkAccount`. Because of this, the Google `signIn` callback creates `users` and `accounts` rows manually (see [signIn callback](#signin-callback)).

The adapter-relevant tables (`users`, `accounts`, `sessions`, `verification_tokens`) are defined in `src/db/schema.ts`. See [Database & Schema](./database.md) for their full column reference.

### JWT session strategy

```ts
session: { strategy: "jwt" }, // Required for the Credentials provider
```

Auth.js v5 requires a JWT strategy when using the Credentials provider (database sessions are incompatible with Credentials). The consequence is that **no rows are written to the `sessions` table at runtime** — the signed JWT in the cookie is the source of truth. The `sessions` table exists in the schema for adapter compatibility but is unused.

See [Session management](#session-management-getsessionuser) for how the JWT is read.

## Providers

### Credentials (email + password)

Always enabled. The `authorize` function looks up the user by email, verifies the password with bcrypt, and returns a minimal user object:

```ts
Credentials({
  credentials: { email: {}, password: {} },
  authorize: async (credentials) => {
    const email = String(credentials.email ?? "").toLowerCase().trim();
    const password = String(credentials.password ?? "");
    if (!email || !password) return null;
    const [user] = await db
      .select({ id, nickname, email, passwordHash })
      .from(users)
      .where(eq(users.email, email));
    if (!user || !user.passwordHash) return null; // Reject Credentials for OAuth-only users
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return null;
    return { id: user.id, name: user.nickname, email: user.email };
  },
}),
```

Key behaviors:
- Email is lowercased and trimmed before lookup.
- Users with a `null` `passwordHash` (Google-only accounts) are rejected — they must log in via Google.
- Returning `null` from `authorize` triggers a generic "invalid credentials" error on the client.

### Google OAuth (conditional)

Google is included only when both env vars are present, so the app runs with Credentials alone in environments without OAuth configured:

```ts
...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? [
      Google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    ]
  : []),
```

Because the JWT strategy means the adapter's `createUser`/`linkAccount` never run, the Google `signIn` callback manually creates or links the `users`/`accounts` rows (see [signIn callback](#signin-callback)).

The login page reads the same env vars to decide whether to show the "Sign in with Google" button:

```ts
// src/app/login/page.tsx
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
```

The `signInWithGoogle` server action (`src/app/actions/auth.ts`) starts the OAuth flow. It is a server action rather than a direct client call so that `auth.ts` (and its DB imports) are not pulled into the browser bundle.

## Callbacks

Auth.js v5 invokes four callbacks. Three live in `auth.ts`; `authorized` lives in the edge-safe `auth.config.ts`.

### `authorized`

Gates **page routes only**. The proxy matcher excludes `/api/*`, so API routes are never handled here — each route authenticates via `getSessionUser()`.

```ts
authorized: ({ auth, request }) => {
  const isLoginPage = request.nextUrl.pathname.startsWith("/login");
  if (isLoginPage)
    return !!auth
      ? Response.redirect(new URL("/", request.nextUrl.origin)) // logged-in → /
      : true; // logged-out can view /login
  return !!auth; // all other pages require auth → false redirects to /login
},
```

### `signIn`

Called before login completes. It **only acts on Google logins** — it returns early (`return true`) for Credentials, so it has no effect on email/password auth.

For Google, it either links the Google account to an existing user or creates a new user. This manual creation is necessary because the JWT strategy causes `handleLoginOrRegister` to find the account row and skip the adapter's `createUser`/`linkAccount`.

```ts
signIn: async ({ user, account }) => {
  if (account?.provider !== "google" || !user?.email) return true;
  const email = user.email.toLowerCase().trim();

  // 1. Existing user by email → link Google account (create accounts row if missing)
  const [existing] = await db.select({ id }).from(users).where(eq(users.email, email));
  if (existing) {
    // insert accounts row if it doesn't exist (idempotent link)
    return true;
  }

  // 2. No existing user → create user (passwordHash = null) + accounts row
  await db.insert(users).values({ nickname, email, name, image, emailVerified });
  await db.insert(accounts).values({ userId, type: "oauth", provider: "google", ... });
  return true;
},
```

Key behaviors:
- **Email linking:** if a user with the same email already exists (e.g. registered via Credentials), the Google account is linked to that user by inserting an `accounts` row. The lookup is idempotent — it checks for an existing `accounts` row first.
- **New Google users** get `passwordHash = null`, so they cannot log in via Credentials (the `authorize` function rejects them).
- The `accounts` table has a `(provider, providerAccountId)` unique index to prevent duplicate rows.

### `jwt`

Attaches `userId` to the JWT payload on first login (when `user` is present):

```ts
jwt: async ({ token, user }) => {
  if (user) token.userId = user.id;
  return token;
},
```

After the initial sign-in, `user` is `undefined` on subsequent token refreshes, so `token.userId` is preserved across the session lifetime.

### `session`

Exposes `userId` to the session object by reading it from the JWT. It also performs a **liveness check** — if the user no longer exists in the database, `session.user.id` is left unset, which causes `authorized` to return `false` and forces a redirect to `/login`:

```ts
session: async ({ session, token }) => {
  if (token?.userId) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, token.userId as string))
      .limit(1);
    if (row) {
      session.user = { ...session.user, id: token.userId as string };
    }
    // if row is missing, session.user.id stays unset → authorized returns false → redirect to /login
  }
  return session;
},
```

This handles the case where the database is recreated or the user is deleted while a valid JWT cookie still exists.

## Session management: `getSessionUser()`

`getSessionUser()` (`src/lib/auth-guards.ts`) is the **universal guard for all API routes**. It reads the JWT from the request cookies via `auth()`, then verifies the user still exists in the database.

```ts
export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null; // user no longer exists → invalidate session
  return session.user as SessionUser;
}
```

### Why it returns `null` instead of throwing

`getSessionUser()` deliberately returns `null` rather than throwing a 401. This lets each route handler control its own error response shape:

```ts
// Standard pattern at the top of every API route
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  // ... use user.id to scope queries
}
```

Some routes redirect instead of returning 401 — for example, the Notion OAuth callback redirects to `/login`:

```ts
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return redirect("/login");
  // ...
}
```

### Double validation

`getSessionUser()` performs two checks:

1. **JWT present and valid** — `auth()` decodes the cookie; `session.user.id` is only set if the `session` callback confirmed the user exists.
2. **User exists in DB** — a second `SELECT` against `users` catches the case where the database was recreated after the JWT was issued. If the row is gone, `null` is returned and every route returns 401, prompting the client to redirect to `/login`.

## User data isolation

Every API route scopes its database queries by the authenticated user's `id`. This is the core isolation mechanism — there is no server-side tenant filter or row-level security; each query explicitly includes `userId` in its `WHERE` clause.

### List queries (GET)

All list endpoints filter by `userId`:

```ts
// src/app/api/threads/route.ts — GET
const user = await getSessionUser();
if (!user) return new Response("Unauthorized", { status: 401 });
const rows = await db
  .select({ ... })
  .from(threads)
  .where(eq(threads.userId, user.id))   // ← scope by owner
  .orderBy(desc(threads.updatedAt));
```

The same pattern is used for `folders`, `memories` (via thread join), `mcp_servers`, `connections`, `global_instructions`, `skills`, and `skill_candidates`.

### Single-resource mutations (DELETE / PATCH)

Mutations on a specific resource (by `id`) always combine the resource `id` **and** the `userId` in the `WHERE` clause. This prevents a user from deleting or modifying another user's resource by guessing its `id`:

```ts
// src/app/api/threads/[id]/route.ts — DELETE
const { id } = await ctx.params;
const user = await getSessionUser();
if (!user) return new Response("Unauthorized", { status: 401 });
const [row] = await db
  .delete(threads)
  .where(and(eq(threads.id, id), eq(threads.userId, user.id)))  // ← id AND owner
  .returning();
if (!row) return new Response("Not found", { status: 404 });
```

Returning `404 Not Found` (rather than `403 Forbidden`) when the row doesn't exist is intentional — it avoids leaking whether a resource exists for another user. This applies to every `[id]` route: `threads`, `folders`, `memories`, `mcp_servers`, `connections`, `global_instructions`.

### Tables without a direct `userId` column

Some tables (e.g. `memories`) do not have their own `userId` column — they belong to a user transitively via a `threadId`. These routes use an `innerJoin` to enforce ownership through the parent `threads` table:

```ts
// src/app/api/memories/[id]/route.ts — assertOwned helper
async function assertOwned(id: string, userId: string) {
  const [row] = await db
    .select({ threadId: memories.threadId })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(eq(memories.id, id), eq(threads.userId, userId)))  // ← scope via parent
    .limit(1);
  return row ?? null;
}
```

This `assertOwned` pattern is used before any mutation on a resource that has no direct `userId` column.

### Summary of scoping patterns

| Operation | Pattern | Example |
|-----------|---------|---------|
| List all of a user's resources | `.where(eq(table.userId, user.id))` | `GET /api/threads` |
| Delete/patch a specific resource | `.where(and(eq(table.id, id), eq(table.userId, user.id)))` | `DELETE /api/threads/[id]` |
| Mutate a resource with no `userId` | `innerJoin` parent + `.where(and(eq(child.id, id), eq(parent.userId, user.id)))` | `DELETE /api/memories/[id]` |

## First-run admin account creation

There is no built-in admin account or CLI seed command. The first user is created through the normal registration form on the login page.

### Detection

The login page (`src/app/login/page.tsx`) counts users. If the count is `0`, the form starts in **register mode** and shows a first-run banner:

```ts
const userCount = await db.$count(users);
const firstRun = userCount === 0;
// <LoginForm initialMode={firstRun ? "register" : "login"} firstRun={firstRun} ... />
```

### Registration flow

The `register` server action (`src/app/actions/auth.ts`) runs the creation and the first-user check inside a single transaction to avoid a race condition where two concurrent registrations both see `userCount === 0`:

```ts
const [user, userCount] = await db.transaction(async (tx) => {
  const count = await tx.$count(users);
  const [inserted] = await tx
    .insert(users)
    .values({ nickname, email, passwordHash })
    .returning({ id: users.id, nickname: users.nickname, email: users.email });
  return [inserted, count] as const;
});

if (userCount === 0) {
  // First user: migrate all ownerless threads + folders to this user
  await db.update(threads).set({ userId: user.id }).where(isNull(threads.userId));
  await db.update(folders).set({ userId: user.id }).where(isNull(folders.userId));
}

await signIn("credentials", { email, password, redirect: false });
redirect("/");
```

### What "first user" means

- **No explicit admin role.** The first user is not granted elevated privileges — they simply become the owner of any pre-existing ownerless `threads` and `folders` (e.g. from a database restore or a pre-seeded dataset).
- **Validation:** nickname (≥1 char), valid email format, password ≥ 8 characters.
- **Auto-login:** after creation, the user is signed in immediately and redirected to `/`.
- **Duplicate email** returns an error without creating the account.

### Why ownerless data exists

Threads and folders have a nullable `userId` column. Data created before any user existed (or via a legacy import) has `userId = NULL`. The first user inherits all of it so nothing is orphaned. Subsequent users start with an empty workspace.

## Password hashing

Passwords are hashed with **bcrypt** via the `bcryptjs` package (pure JavaScript, no native build step — important for Windows and Docker compatibility).

```ts
// src/lib/password.ts
import bcrypt from "bcryptjs";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10); // cost factor = 10
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- **Cost factor:** 10 (the bcrypt default for `bcryptjs`). This is the number of key-expansion rounds (2^10 = 1024).
- `hashPassword` is called only in the `register` server action.
- `verifyPassword` is called in the Credentials `authorize` function.
- Google-only users have `passwordHash = null` and cannot use Credentials login.

## Auth-related environment variables

All auth env vars are defined in `.env.example`. See [Settings & Environment](./settings-env.md) for the full env reference and the runtime settings GUI.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AUTH_SECRET` | Yes | — | HMAC secret for signing JWTs. Generate with `bunx auth secret`. |
| `AUTH_TRUST_HOST` | Yes | `true` | Trusts the `X-Forwarded-Host` header. Required behind reverse proxies (Docker, Cloudflare Tunnel). |
| `AUTH_URL` | Yes | `http://localhost:3001` | Configured public base URL for Settings UI, tunnel status, and OAuth-console redirect URI matching. Auth.js no longer reads this for request-origin rewriting; redirects follow the incoming request Host header (dual local + Cloudflare access). |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth client ID. Enables "Sign in with Google" when set together with `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_SECRET` | No | — | Google OAuth client secret. |

### `AUTH_URL`

`AUTH_URL` is the configured public base URL of the deployment. It serves as the canonical name for the Settings UI, tunnel status display, and OAuth-provider console redirect URI registration.

**Dual-access behavior:** Auth.js no longer reads `AUTH_URL` for request-origin rewriting. At module load, `src/lib/auth-env.ts` copies `AUTH_URL` into an internal mirror (`UMANS_CONFIGURED_AUTH_URL`) and deletes `process.env.AUTH_URL` so Auth.js's `reqWithEnvURL` is a no-op. Under `AUTH_TRUST_HOST=true`, Auth.js derives the origin from the incoming request's `X-Forwarded-Host` / `Host` + `X-Forwarded-Proto` headers. This means both `http://localhost:3001` and a public `https://...` URL work simultaneously — redirects follow the access path, not a sticky env value.

The `authorized` callback in `src/auth.config.ts` uses `resolvePublicOrigin()` (from `src/lib/request-origin.ts`) to build redirect URLs from the request headers, falling back to `UMANS_CONFIGURED_AUTH_URL` only when no host header is present.

OAuth redirect URIs are derived from the request origin the same way:
1. **Google OAuth** — `{origin}/api/auth/callback/google` (origin from request headers via Auth.js).
2. **Notion OAuth** — `{origin}/api/connections/notion/callback` (read via `resolvePublicOrigin` in the Notion routes).

When using a Cloudflare Tunnel, set `AUTH_URL` to the tunnel's public HTTPS URL so the Settings UI and OAuth consoles know the public name. The tunnel API (`POST /api/tunnel`) saves `AUTH_URL` to `.env` and mirrors it to `UMANS_CONFIGURED_AUTH_URL` at runtime — no restart needed. See [Deployment](./deployment.md) for the tunnel setup.

> **Dual OAuth:** if both local and public access need Connect Notion / Google, register both redirect URIs (`http://localhost:3001/...` and `https://your-tunnel.example.com/...`) in the provider console. Page routing does not depend on OAuth registration.

### `AUTH_TRUST_HOST`

Must be `true` in any deployment behind a proxy (Docker, Cloudflare Tunnel, etc.). Without it, Auth.js ignores the `X-Forwarded-Host` header and may reject valid requests.

## Adding a new auth provider

To add a new OAuth/OIDC provider (e.g. GitHub, Microsoft):

### 1. Install the provider package

Auth.js v5 providers live in `@auth/core/providers/*`. Most are included with `next-auth` — no extra install needed for common providers.

### 2. Add env vars to `.env.example`

```env
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

### 3. Conditionally include the provider in `src/auth.ts`

Follow the Google pattern — include the provider only when its env vars are set, so the app still runs without it:

```ts
import GitHub from "next-auth/providers/github";

// in the providers array:
...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? [
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      }),
    ]
  : []),
```

### 4. Extend the `signIn` callback

Because the JWT strategy means the adapter's `createUser`/`linkAccount` never run, you must handle user/account creation manually for any new OAuth provider. Extend the existing `signIn` callback's early-return guard:

```ts
signIn: async ({ user, account }) => {
  // Update this guard to include the new provider:
  if (
    (account?.provider !== "google" && account?.provider !== "github") ||
    !user?.email
  ) {
    return true;
  }
  // ... existing link-or-create logic (works for any provider)
},
```

The link-or-create logic (find existing user by email, insert `accounts` row) is provider-agnostic — it uses `account.provider`, `account.providerAccountId`, and the standard OAuth token fields, so it works unchanged for any OAuth provider.

### 5. Add a server action for the login button

Following the `signInWithGoogle` pattern, add a server action so the provider's `auth.ts` import is not pulled into the client bundle:

```ts
// src/app/actions/auth.ts
export async function signInWithGitHub(): Promise<void> {
  await signIn("github", { callbackUrl: "/" });
}
```

### 6. Update the login page

Expose the provider in the login UI by reading the env var:

```ts
// src/app/login/page.tsx
const githubEnabled = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
// pass to <LoginForm ... githubEnabled={githubEnabled} />
```

### 7. Configure the redirect URI

Set the authorized redirect URI in the provider's developer console to:

```
{AUTH_URL}/api/auth/callback/github
```

## See also

- [Database & Schema](./database.md) — `users`, `accounts`, `sessions`, `verification_tokens` table definitions
- [Settings & Environment](./settings-env.md) — full env var reference and the runtime settings GUI
- [Deployment](./deployment.md) — Docker, standalone exe, and Cloudflare Tunnel setup (affects `AUTH_URL`)

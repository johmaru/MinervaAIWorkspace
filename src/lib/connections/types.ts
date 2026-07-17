/**
 * Shared types for OAuth Connection providers.
 *
 * ConnectionRow is the minimal shape loaded from the connections table and
 * passed to getConnectionTools / dispatchConnectionTool. Provider modules
 * receive this row plus tool call args and return a DispatchResult.
 *
 * Token refresh contract:
 * - newAccessToken: persist when present (access-only persist allowed)
 * - newRefreshToken: persist only when present (Google/Microsoft may rotate;
 *   GitHub OAuth Apps never return one)
 * - expiresAt: persist when present (GitHub OAuth App tokens never expire)
 */

/** Result of dispatching a connection tool call. */
export type DispatchResult = {
  content: string;
  /** New access token from a refresh; persist if present. */
  newAccessToken?: string;
  /** New refresh token from a refresh; persist if present (may be absent if not rotated). */
  newRefreshToken?: string;
  /** New access-token expiry; persist if present. */
  newExpiresAt?: Date;
};

/** Shape of a connection row as loaded by loadConnections. */
export type ConnectionRow = {
  id: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  scopes: string | null;
  expiresAt: Date | null;
  workspaceName: string | null;
};

import bcrypt from "bcryptjs";

/**
 * Hashes a password with bcrypt (cost=10).
 * bcryptjs is pure-JS, requiring no Windows/native build.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/**
 * Compares a plaintext password against a hash.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

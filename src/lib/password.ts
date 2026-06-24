import bcrypt from "bcryptjs";

/**
 * パスワードを bcrypt でハッシュ化（cost=10）。
 * bcryptjs は pure-JS で Windows/native build 不要。
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/**
 * 平文パスワードとハッシュを照合。
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

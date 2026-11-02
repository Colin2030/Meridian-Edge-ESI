import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  uid: number;
  username: string;
  isSystemAdmin: boolean;
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}
export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}
export function signToken(p: TokenPayload): string {
  return jwt.sign(p, config.sessionSecret, { expiresIn: '12h' });
}
export function verifyToken(t: string): TokenPayload | null {
  try {
    return jwt.verify(t, config.sessionSecret) as TokenPayload;
  } catch {
    return null;
  }
}

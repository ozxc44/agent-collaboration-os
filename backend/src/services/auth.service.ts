import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../data-source';
import { User } from '../entities/user.entity';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = '24h';
const BCRYPT_ROUNDS = 10;

export interface AuthResult {
  accessToken: string;
  tokenType: string;
  expiresAt: string;
}

export interface UserInfo {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  ownerAgentId: string | null;
  createdAt: Date;
}

export class AuthService {
  private userRepo = AppDataSource.getRepository(User);

  /**
   * Register a new user with email, password, and display name.
   * Returns a JWT token for the newly created user.
   */
  async register(
    email: string,
    password: string,
    displayName: string,
    username?: string,
  ): Promise<AuthResult & { user: UserInfo }> {
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new AuthServiceError('Email already registered', 409);
    }

    const finalUsername = await this.resolveUsername(
      username,
      displayName,
      email,
    );

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = this.userRepo.create({
      email,
      passwordHash,
      displayName,
      username: finalUsername,
    });

    await this.userRepo.save(user);

    const token = this.generateToken(user.id);
    const expiresAt = this.getExpiresAt();

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        username: user.username ?? null,
        displayName: user.displayName,
        ownerAgentId: user.ownerAgentId ?? null,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * Log in with email/username and password.
   * Returns a JWT token on success.
   */
  async login(identifier: string, password: string): Promise<AuthResult & { user: UserInfo }> {
    const user = await this.userRepo.findOne({
      where: [{ email: identifier }, { username: identifier }],
    });
    if (!user) {
      throw new AuthServiceError('Invalid email or password', 401);
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new AuthServiceError('Invalid email or password', 401);
    }

    const token = this.generateToken(user.id);
    const expiresAt = this.getExpiresAt();

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        username: user.username ?? null,
        displayName: user.displayName,
        ownerAgentId: user.ownerAgentId ?? null,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * Get current user information by user ID.
   */
  async getMe(userId: string): Promise<UserInfo> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new AuthServiceError('User not found', 404);
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username ?? null,
      displayName: user.displayName,
      ownerAgentId: user.ownerAgentId ?? null,
      createdAt: user.createdAt,
    };
  }

  private generateToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  private getExpiresAt(): string {
    const date = new Date();
    date.setHours(date.getHours() + 24);
    return date.toISOString();
  }

  private async resolveUsername(
    requestedUsername: string | undefined,
    displayName: string,
    email: string,
  ): Promise<string | null> {
    const base = requestedUsername
      ? this.slugify(requestedUsername)
      : this.slugify(displayName) || this.slugify(email.split('@')[0]);

    if (!base) {
      return null;
    }

    let candidate = base.slice(0, 64);
    let suffix = 2;
    while (true) {
      const existing = await this.userRepo.findOne({
        where: { username: candidate },
      });
      if (!existing) {
        return candidate;
      }
      const suffixStr = `-${suffix}`;
      candidate = `${base.slice(0, 64 - suffixStr.length)}${suffixStr}`;
      suffix++;
    }
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }
}

export class AuthServiceError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AuthServiceError';
    this.statusCode = statusCode;
  }
}

export const authService = new AuthService();

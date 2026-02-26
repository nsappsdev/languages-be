import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../utils/password';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(2).max(80),
  password: z
    .string()
    .min(6)
    .regex(/[A-Za-z]/, 'Password must include at least one letter')
    .regex(/[0-9]/, 'Password must include at least one number'),
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(32),
});

const logoutSchema = z
  .object({
    refreshToken: z.string().trim().min(32).optional(),
  })
  .optional();

const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseDurationToMs(input: string): number {
  const trimmed = input.trim();
  const parsed = /^(\d+)\s*([smhdw])$/i.exec(trimmed);
  if (!parsed) {
    return DEFAULT_REFRESH_TOKEN_TTL_MS;
  }

  const value = Number(parsed[1]);
  const unit = parsed[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  const multiplier = multipliers[unit];
  if (!Number.isFinite(value) || value <= 0 || !multiplier) {
    return DEFAULT_REFRESH_TOKEN_TTL_MS;
  }

  return value * multiplier;
}

function hashRefreshToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createAccessToken(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtAccessTokenTtl as SignOptions['expiresIn'],
  });
}

async function issueRefreshToken(userId: string) {
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + parseDurationToMs(config.jwtRefreshTokenTtl));

  await prisma.authRefreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken),
      userId,
      expiresAt,
    },
  });

  return refreshToken;
}

async function buildAuthResponse(user: { id: string; email: string; name: string; role: string }) {
  const refreshToken = await issueRefreshToken(user.id);

  return {
    token: createAccessToken(user),
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
}

router.post('/auth/login', async (req, res) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parseResult.error.flatten() });
  }

  const email = parseResult.data.email.trim().toLowerCase();
  const { password } = parseResult.data;
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user || !verifyPassword(password, user.passwordHash, user.salt)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  return res.json(await buildAuthResponse(user));
});

router.post('/auth/signup', async (req, res) => {
  const parseResult = signupSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parseResult.error.flatten() });
  }

  const email = parseResult.data.email.trim().toLowerCase();
  const name = parseResult.data.name.trim();
  const { password } = parseResult.data;

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    return res.status(409).json({ message: 'Email is already registered' });
  }

  const { hash, salt } = hashPassword(password);
  const createdUser = await prisma.user.create({
    data: {
      email,
      name,
      role: 'learner',
      passwordHash: hash,
      salt,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
    },
  });

  return res.status(201).json(await buildAuthResponse(createdUser));
});

router.post('/auth/refresh', async (req, res) => {
  const parseResult = refreshSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parseResult.error.flatten() });
  }

  const tokenHash = hashRefreshToken(parseResult.data.refreshToken);
  const stored = await prisma.authRefreshToken.findUnique({
    where: { tokenHash },
  });

  if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }

  const user = await prisma.user.findUnique({
    where: { id: stored.userId },
    select: { id: true, email: true, name: true, role: true },
  });

  if (!user) {
    await prisma.authRefreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }

  await prisma.authRefreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return res.json(await buildAuthResponse(user));
});

router.post('/auth/logout', authenticate, async (req: AuthenticatedRequest, res) => {
  const parseResult = logoutSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parseResult.error.flatten() });
  }

  const now = new Date();
  if (req.user) {
    await prisma.authRefreshToken.updateMany({
      where: {
        userId: req.user.id,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
  }

  const providedRefreshToken = parseResult.data?.refreshToken;
  if (providedRefreshToken) {
    await prisma.authRefreshToken.updateMany({
      where: {
        tokenHash: hashRefreshToken(providedRefreshToken),
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });
  }

  return res.json({ message: 'Logged out' });
});

router.get('/auth/profile', authenticate, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    },
  });
});

export { router as authRouter };

import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../utils/password';
import { sendVerificationEmail } from '../lib/email';
import { verifyGoogleIdToken } from '../lib/googleAuth';

const router = Router();

// ─── Schemas ────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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

const resendVerificationSchema = z.object({
  email: z.string().email(),
});

const googleSignInSchema = z.object({
  idToken: z.string().min(1),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseDurationToMs(input: string): number {
  const trimmed = input.trim();
  const parsed = /^(\d+)\s*([smhdw])$/i.exec(trimmed);
  if (!parsed) return DEFAULT_REFRESH_TOKEN_TTL_MS;

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
  if (!Number.isFinite(value) || value <= 0 || !multiplier) return DEFAULT_REFRESH_TOKEN_TTL_MS;
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
    data: { tokenHash: hashRefreshToken(refreshToken), userId, expiresAt },
  });

  return refreshToken;
}

async function buildAuthResponse(user: { id: string; email: string; name: string; role: string }) {
  const refreshToken = await issueRefreshToken(user.id);
  return {
    token: createAccessToken(user),
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── HTML helpers ───────────────────────────────────────────────────────────

function verifyPage(title: string, body: string, success: boolean): string {
  const color = success ? '#0e7490' : '#b91c1c';
  const icon = success ? '✓' : '✕';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — lezoo.app</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 48px 40px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: ${color}18; color: ${color}; font-size: 24px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; }
    h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 12px; }
    p { font-size: 15px; color: #475569; line-height: 1.6; }
    .brand { margin-top: 32px; font-size: 13px; color: #94a3b8; }
    .brand span { color: ${color}; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <p class="brand">lezoo<span>.app</span></p>
  </div>
</body>
</html>`;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// POST /auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash || !user.salt) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!verifyPassword(parsed.data.password, user.passwordHash, user.salt)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        message: 'Please verify your email before logging in.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    return res.json(await buildAuthResponse(user));
  } catch {
    return res.status(500).json({ message: 'Login failed' });
  }
});

// POST /auth/signup
router.post('/auth/signup', async (req, res) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const name = parsed.data.name.trim();

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return res.status(409).json({ message: 'Email is already registered' });
    }

    const { hash, salt } = hashPassword(parsed.data.password);
    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.create({
      data: {
        email,
        name,
        role: 'learner',
        passwordHash: hash,
        salt,
        authProvider: 'email',
        emailVerified: false,
        emailVerificationToken: token,
        emailVerificationExpiresAt: expiresAt,
      },
    });

    try {
      await sendVerificationEmail(email, name, token);
    } catch (emailErr) {
      console.error('[email] Failed to send verification email:', emailErr);
      // Account is created — do not fail the request over email delivery
    }

    return res.status(201).json({ message: 'Account created. Please check your email to verify your account.' });
  } catch {
    return res.status(500).json({ message: 'Registration failed' });
  }
});

// GET /auth/verify-email?token=...
router.get('/auth/verify-email', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : null;
    if (!token) {
      return res.status(400).send(verifyPage('Invalid link', 'This verification link is invalid.', false));
    }

    const user = await prisma.user.findUnique({
      where: { emailVerificationToken: token },
      select: { id: true, emailVerificationExpiresAt: true, emailVerified: true },
    });

    if (!user) {
      return res.status(400).send(verifyPage('Invalid link', 'This verification link is invalid or has already been used.', false));
    }

    if (user.emailVerified) {
      return res.send(verifyPage('Already verified', 'Your email is already verified. You can sign in to the app.', true));
    }

    if (user.emailVerificationExpiresAt && user.emailVerificationExpiresAt < new Date()) {
      return res.status(400).send(verifyPage('Link expired', 'This verification link has expired. Please sign up again or request a new link from the app.', false));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });

    return res.send(verifyPage('Email verified', 'Your email has been verified successfully. You can now sign in to the app.', true));
  } catch {
    return res.status(500).send(verifyPage('Something went wrong', 'Verification failed. Please try again.', false));
  }
});

// POST /auth/resend-verification
router.post('/auth/resend-verification', async (req, res) => {
  try {
    const parsed = resendVerificationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, emailVerified: true },
    });

    // Always return 200 to avoid email enumeration
    if (!user || user.emailVerified) {
      return res.json({ message: 'If that email exists and is unverified, a new link has been sent.' });
    }

    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: token, emailVerificationExpiresAt: expiresAt },
    });

    await sendVerificationEmail(email, user.name, token);

    return res.json({ message: 'If that email exists and is unverified, a new link has been sent.' });
  } catch {
    return res.status(500).json({ message: 'Failed to resend verification email' });
  }
});

// POST /auth/google  — body: { idToken: string }
router.post('/auth/google', async (req, res) => {
  try {
    const parsed = googleSignInSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const profile = await verifyGoogleIdToken(parsed.data.idToken);

    // Find by googleId first, then fall back to email (account linking)
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
    });

    if (user) {
      // Link googleId if signing in with Google for the first time on an existing email account
      if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId: profile.googleId, emailVerified: true },
        });
      }
    } else {
      user = await prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name,
          role: 'learner',
          authProvider: 'google',
          googleId: profile.googleId,
          emailVerified: true,
        },
      });
    }

    return res.json(await buildAuthResponse(user));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Google sign-in failed';
    return res.status(401).json({ message });
  }
});

// POST /auth/refresh
router.post('/auth/refresh', async (req, res) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    const stored = await prisma.authRefreshToken.findUnique({ where: { tokenHash } });

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
  } catch {
    return res.status(500).json({ message: 'Token refresh failed' });
  }
});

// POST /auth/logout
router.post('/auth/logout', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = logoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const now = new Date();
    if (req.user) {
      await prisma.authRefreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    const providedToken = parsed.data?.refreshToken;
    if (providedToken) {
      await prisma.authRefreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(providedToken), revokedAt: null },
        data: { revokedAt: now },
      });
    }

    return res.json({ message: 'Logged out' });
  } catch {
    return res.status(500).json({ message: 'Logout failed' });
  }
});

// GET /auth/profile
router.get('/auth/profile', authenticate, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  return res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role },
  });
});

export { router as authRouter };

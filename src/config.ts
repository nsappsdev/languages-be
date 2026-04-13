import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PORT = 4000;

export const config = {
  port: parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT,
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtAccessTokenTtl: process.env.JWT_ACCESS_TOKEN_TTL ?? '1h',
  jwtRefreshTokenTtl: process.env.JWT_REFRESH_TOKEN_TTL ?? '30d',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:4000',
  smtp: {
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'noreply@lezoo.app',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
};

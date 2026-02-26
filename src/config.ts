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
};

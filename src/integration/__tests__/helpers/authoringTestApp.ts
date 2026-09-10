import http from 'http';
import jwt from 'jsonwebtoken';
import { assertDisposableDatabaseUrl } from './testDbGuard';

assertDisposableDatabaseUrl();

// Imported only after the guard above has already thrown for any
// non-disposable DATABASE_URL, so a write-capable Prisma client is never
// constructed against an unexpected target.
import { createApp } from '../../../app';
import { prisma } from '../../../lib/prisma';
import { config } from '../../../config';

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let adminCounter = 0;

export async function createTestAdminUser() {
  adminCounter += 1;
  const user = await prisma.user.create({
    data: {
      email: `authoring-admin-${Date.now()}-${adminCounter}@example.test`,
      name: 'Authoring Test Admin',
      role: 'admin',
      authProvider: 'test',
      emailVerified: true,
    },
  });
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '1h' });
  return { user, token };
}

export { prisma, config };

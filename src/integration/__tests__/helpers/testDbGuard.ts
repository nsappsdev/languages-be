import dotenv from 'dotenv';

dotenv.config();

/**
 * Refuses to let any integration test import a write-capable Prisma client
 * against anything that doesn't look like an explicit disposable test
 * database. This is deliberately conservative: it is far cheaper to refuse
 * a legitimate disposable DB by mistake than to ever touch a real one.
 */
export function assertDisposableDatabaseUrl() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error('Integration tests require DATABASE_URL to be set to an explicit disposable test database.');
  }
  if (!/disposable/i.test(url)) {
    throw new Error(
      'Refusing to run integration tests: DATABASE_URL does not contain an explicit "disposable" marker. ' +
        'Point DATABASE_URL at a local, throwaway database before running these tests.',
    );
  }
  if (/\bprod\b|production/i.test(url)) {
    throw new Error('Refusing to run integration tests: DATABASE_URL looks production-like.');
  }
}

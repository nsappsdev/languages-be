import dotenv from 'dotenv';
dotenv.config();
export function assertDisposableDatabaseUrl() {
  const value = process.env.DATABASE_URL ?? '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Integration tests require an explicit local disposable DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/disposable/i.test(url.pathname) || /prod|production/i.test(url.pathname))
    throw new Error('Refusing integration tests: require a local database whose name contains disposable');
}

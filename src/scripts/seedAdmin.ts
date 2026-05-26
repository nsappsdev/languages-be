import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../utils/password';

const prisma = new PrismaClient();

const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123';
const name = process.env.SEED_ADMIN_NAME ?? 'Admin User';
const mobileEmail = process.env.SEED_MOBILE_USER_EMAIL ?? 'user@email.com';
const mobilePassword = process.env.SEED_MOBILE_USER_PASSWORD ?? 'user#666';
const mobileName = process.env.SEED_MOBILE_USER_NAME ?? 'Mobile Learner';

async function seedAdmin() {
  const { hash, salt } = hashPassword(password);

  await prisma.user.upsert({
    where: { email },
    update: {
      name,
      role: 'admin',
      passwordHash: hash,
      salt,
      emailVerified: true,
    },
    create: {
      email,
      name,
      role: 'admin',
      passwordHash: hash,
      salt,
      authProvider: 'email',
      emailVerified: true,
    },
  });

  console.log(`Admin user ready: ${email} / ${password}`);
}

async function seedMobileUser() {
  const { hash, salt } = hashPassword(mobilePassword);

  await prisma.user.upsert({
    where: { email: mobileEmail },
    update: {
      name: mobileName,
      role: 'learner',
      passwordHash: hash,
      salt,
      emailVerified: true,
    },
    create: {
      email: mobileEmail,
      name: mobileName,
      role: 'learner',
      passwordHash: hash,
      salt,
      authProvider: 'email',
      emailVerified: true,
    },
  });

  console.log(`Mobile user ready: ${mobileEmail} / ${mobilePassword}`);
}

async function seedAppSettings() {
  await prisma.appSettings.upsert({
    where: { id: 'global' },
    create: {
      id: 'global',
      readingModes: [
        { id: 'introduction', enabled: true, displayName: 'Introduction', order: 0 },
        {
          id: 'teaching',
          enabled: true,
          displayName: 'Teaching',
          order: 1,
          unknownWordRepetitions: 5,
        },
        {
          id: 'deep_learning',
          enabled: true,
          displayName: 'Deep Learning',
          order: 2,
          unknownWordRepetitions: 5,
          repeatSentenceWhenUnknownCountAtLeast: 2,
          sentenceRepetitions: 2,
        },
      ],
      translationFontMinSize: 8,
      translationFontMaxSize: 15,
      translationLetterSpacingMin: -0.2,
      translationLetterSpacingMax: 0.8,
    },
    update: {},
  });
  console.log('App settings seeded.');
}

async function main() {
  await seedAdmin();
  await seedMobileUser();
  await seedAppSettings();
  console.log('Lesson seeding skipped.');
}

main()
  .catch((error) => {
    console.error('Failed to seed initial data', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

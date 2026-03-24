import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../utils/password';

const prisma = new PrismaClient();

const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'admin123';
const name = process.env.SEED_ADMIN_NAME ?? 'Admin User';
const mobileEmail = process.env.SEED_MOBILE_USER_EMAIL ?? 'user@email.com';
const mobilePassword = process.env.SEED_MOBILE_USER_PASSWORD ?? 'user#666';
const mobileName = process.env.SEED_MOBILE_USER_NAME ?? 'Mobile Learner';

type SeedSegment = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

type SeedLessonItem = {
  id: string;
  order: number;
  text: string;
  audioUrl: string;
  segments: SeedSegment[];
};

const seedItems: SeedLessonItem[] = [
  {
    id: 'seed-item-1',
    order: 0,
    text: 'Hello and welcome. Today we will learn greetings.',
    audioUrl: '/media/audio/greetings-1.wav',
    segments: [
      { id: 'seg-1', text: 'Hello and welcome.', startMs: 0, endMs: 1800 },
      { id: 'seg-2', text: 'Today we will learn greetings.', startMs: 1900, endMs: 4300 },
    ],
  },
  {
    id: 'seed-item-2',
    order: 1,
    text: 'Good morning. Good afternoon. Good evening.',
    audioUrl: '/media/audio/greetings-2.wav',
    segments: [
      { id: 'seg-3', text: 'Good morning.', startMs: 0, endMs: 1200 },
      { id: 'seg-4', text: 'Good afternoon.', startMs: 1400, endMs: 2900 },
      { id: 'seg-5', text: 'Good evening.', startMs: 3100, endMs: 4500 },
    ],
  },
  {
    id: 'seed-item-3',
    order: 2,
    text: 'Nice to meet you. It is good to see you.',
    audioUrl: '/media/audio/greetings-3.wav',
    segments: [
      { id: 'seg-6', text: 'Nice to meet you.', startMs: 0, endMs: 1900 },
      { id: 'seg-7', text: 'It is good to see you.', startMs: 2100, endMs: 4300 },
    ],
  },
];

async function seedAdmin() {
  const { hash, salt } = hashPassword(password);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      name,
      role: 'admin',
      passwordHash: hash,
      salt,
    },
    create: {
      email,
      name,
      role: 'admin',
      passwordHash: hash,
      salt,
    },
  });

  console.log(`Admin user ready: ${email} / ${password}`);
  return admin;
}

async function seedMobileUser() {
  const { hash, salt } = hashPassword(mobilePassword);

  const mobileUser = await prisma.user.upsert({
    where: { email: mobileEmail },
    update: {
      name: mobileName,
      role: 'learner',
      passwordHash: hash,
      salt,
    },
    create: {
      email: mobileEmail,
      name: mobileName,
      role: 'learner',
      passwordHash: hash,
      salt,
    },
  });

  console.log(`Mobile user ready: ${mobileEmail} / ${mobilePassword}`);
  return mobileUser;
}

async function seedLessons(authorId: string) {
  const lesson = await prisma.lesson.upsert({
    where: { id: 'seed-lesson-1' },
    update: {
      title: 'Greetings Basics',
      description: 'A text-and-audio lesson for basic greetings.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId,
    },
    create: {
      id: 'seed-lesson-1',
      title: 'Greetings Basics',
      description: 'A text-and-audio lesson for basic greetings.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId,
    },
  });

  await prisma.lessonItem.deleteMany({ where: { lessonId: lesson.id } });

  await prisma.lessonItem.createMany({
    data: seedItems.map((item) => ({
      id: item.id,
      lessonId: lesson.id,
      order: item.order,
      text: item.text,
      audioUrl: item.audioUrl,
      segments: item.segments as Prisma.InputJsonValue,
    })),
  });

  const itemCount = await prisma.lessonItem.count({ where: { lessonId: lesson.id } });
  console.log(`Seeded lesson "Greetings Basics" with ${itemCount} lesson items.`);
}

async function seedVocabulary(authorId: string) {
  await prisma.vocabularyEntry.upsert({
    where: { id: 'vocab-hello-1' },
    update: {},
    create: {
      id: 'vocab-hello-1',
      englishText: 'Hello',
      kind: 'WORD',
      notes: 'Basic greeting',
      createdById: authorId,
      translations: {
        create: [
          { languageCode: 'es', translation: 'Hola' },
          { languageCode: 'fr', translation: 'Bonjour' },
        ],
      },
    },
  });

  await prisma.vocabularyEntry.upsert({
    where: { id: 'vocab-nice-to-meet-you' },
    update: {},
    create: {
      id: 'vocab-nice-to-meet-you',
      englishText: 'Nice to meet you',
      kind: 'PHRASE',
      createdById: authorId,
      notes: 'Polite greeting phrase',
      translations: {
        create: [
          { languageCode: 'es', translation: 'Mucho gusto' },
          { languageCode: 'fr', translation: 'Ravi de vous rencontrer' },
        ],
      },
    },
  });

  console.log('Seeded vocabulary entries with translations.');
}

async function main() {
  const admin = await seedAdmin();
  await seedMobileUser();
  await seedLessons(admin.id);
  await seedVocabulary(admin.id);
}

main()
  .catch((error) => {
    console.error('Failed to seed initial data', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

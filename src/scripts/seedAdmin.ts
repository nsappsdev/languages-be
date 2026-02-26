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

type SeedTask = {
  id: string;
  prompt: string;
  type: 'PICK_ONE' | 'FILL_IN_BLANK' | 'MATCH';
  order: number;
  config: Prisma.InputJsonValue;
  options?: Array<{ label: string; isCorrect: boolean }>;
};

const seedTasks: SeedTask[] = [
  {
    id: 'seed-task-1',
    prompt: 'Choose the most polite way to start an order.',
    type: 'PICK_ONE',
    order: 1,
    config: {
      skill: 'politeness',
      difficulty: 'easy',
      hints: ['Use a polite question form.'],
    },
    options: [
      { label: 'Give me coffee now.', isCorrect: false },
      { label: 'Could I have a coffee, please?', isCorrect: true },
      { label: 'Coffee.', isCorrect: false },
      { label: 'Bring coffee.', isCorrect: false },
    ],
  },
  {
    id: 'seed-task-2',
    prompt: 'Select the sentence that sounds natural in a cafe.',
    type: 'PICK_ONE',
    order: 2,
    config: {
      skill: 'natural-phrasing',
      difficulty: 'easy',
    },
    options: [
      { label: "I'd like a small cappuccino, please.", isCorrect: true },
      { label: 'I desire one cappuccino small.', isCorrect: false },
      { label: 'Small cappuccino I want.', isCorrect: false },
    ],
  },
  {
    id: 'seed-task-3',
    prompt: 'Fill in the blank: "Could I get a ___ latte, please?"',
    type: 'FILL_IN_BLANK',
    order: 3,
    config: {
      correctAnswers: ['medium'],
      caseSensitive: false,
      acceptedVariants: ['regular'],
    },
  },
  {
    id: 'seed-task-4',
    prompt: 'Fill in the blank: "I would like it ___ sugar."',
    type: 'FILL_IN_BLANK',
    order: 4,
    config: {
      correctAnswers: ['without'],
      caseSensitive: false,
      acceptedVariants: ['with no'],
    },
  },
  {
    id: 'seed-task-5',
    prompt: 'Match each size to the usual cup volume.',
    type: 'MATCH',
    order: 5,
    config: {
      pairs: [
        { left: 'Small', right: '8 oz' },
        { left: 'Medium', right: '12 oz' },
        { left: 'Large', right: '16 oz' },
      ],
      instructions: 'Connect each cup size to its common volume.',
    },
  },
  {
    id: 'seed-task-6',
    prompt: 'A barista asks, "For here or to go?" Pick the best response.',
    type: 'PICK_ONE',
    order: 6,
    config: {
      skill: 'listening-response',
      difficulty: 'easy',
    },
    options: [
      { label: 'To go, please.', isCorrect: true },
      { label: 'I am coffee.', isCorrect: false },
      { label: 'Yes size medium.', isCorrect: false },
      { label: 'No thank.', isCorrect: false },
    ],
  },
  {
    id: 'seed-task-7',
    prompt: 'Fill in the blank: "Can I pay ___ card?"',
    type: 'FILL_IN_BLANK',
    order: 7,
    config: {
      correctAnswers: ['by', 'with my'],
      caseSensitive: false,
      guidance: 'Use a preposition before "card".',
    },
  },
  {
    id: 'seed-task-8',
    prompt: 'Match the cafe phrase to its meaning.',
    type: 'MATCH',
    order: 8,
    config: {
      pairs: [
        { left: 'Takeaway', right: 'You drink it outside the cafe.' },
        { left: 'Extra shot', right: 'An additional espresso added.' },
        { left: 'Decaf', right: 'Coffee with very little caffeine.' },
      ],
      instructions: 'Link each phrase to the correct definition.',
    },
  },
  {
    id: 'seed-task-9',
    prompt: 'Pick the best follow-up question after ordering a drink.',
    type: 'PICK_ONE',
    order: 9,
    config: {
      skill: 'conversation-flow',
      difficulty: 'medium',
    },
    options: [
      { label: 'Can I have it extra hot, please?', isCorrect: true },
      { label: 'I am very coffee today.', isCorrect: false },
      { label: 'Where is grammar?', isCorrect: false },
      { label: 'Please weather hot.', isCorrect: false },
    ],
  },
  {
    id: 'seed-task-10',
    prompt: 'Fill in the blank: "Could you warm it ___, please?"',
    type: 'FILL_IN_BLANK',
    order: 10,
    config: {
      correctAnswers: ['up'],
      caseSensitive: false,
      explanation: 'Phrasal verb: warm up.',
    },
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

  console.log(`✅ Admin user ready: ${email} / ${password}`);
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

  console.log(`📱 Mobile user ready: ${mobileEmail} / ${mobilePassword}`);
  return mobileUser;
}

async function seedLessons(authorId: string) {
  const lesson = await prisma.lesson.upsert({
    where: { id: 'seed-lesson-1' },
    update: {
      title: 'Ordering Coffee',
      description: 'Teach learners how to order coffee politely.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId,
    },
    create: {
      id: 'seed-lesson-1',
      title: 'Ordering Coffee',
      description: 'Teach learners how to order coffee politely.',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId,
    },
  });

  const existingTasks = await prisma.task.findMany({
    where: { lessonId: lesson.id },
    select: { id: true },
  });

  if (existingTasks.length > 0) {
    await prisma.taskOption.deleteMany({
      where: {
        taskId: { in: existingTasks.map((task) => task.id) },
      },
    });
    await prisma.task.deleteMany({ where: { lessonId: lesson.id } });
  }

  for (const task of seedTasks) {
    await prisma.task.create({
      data: {
        id: task.id,
        lessonId: lesson.id,
        prompt: task.prompt,
        type: task.type,
        order: task.order,
        config: task.config,
        options: task.options ? { create: task.options } : undefined,
      },
    });
  }

  const taskCount = await prisma.task.count({ where: { lessonId: lesson.id } });
  console.log(`📘 Seeded lesson "Ordering Coffee" with ${taskCount} tasks.`);
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
    where: { id: 'vocab-how-are-you' },
    update: {},
    create: {
      id: 'vocab-how-are-you',
      englishText: 'How are you?',
      kind: 'PHRASE',
      createdById: authorId,
      notes: 'Common polite question',
      translations: {
        create: [
          { languageCode: 'es', translation: '¿Cómo estás?' },
          { languageCode: 'fr', translation: 'Comment ça va ?' },
        ],
      },
    },
  });

  console.log('🗂 Seeded vocabulary entries with translations.');
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

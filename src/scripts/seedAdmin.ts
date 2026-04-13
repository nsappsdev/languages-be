import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../utils/password';
import {
  canonicalizeVocabularyText,
  ensureVocabularyEntriesForLessonTexts,
} from '../lib/vocabularyIngestion';

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

type SeedVocabularyEntry = {
  id: string;
  englishText: string;
  kind: 'WORD' | 'PHRASE' | 'SENTENCE';
  notes?: string;
  tags?: string[];
  translations: Array<{
    languageCode: string;
    translation: string;
    usageExample?: string;
  }>;
};

type SeedLessonDictionaryEntry = {
  entryId: string;
  order: number;
  sourceItemId?: string;
  notes?: string;
};

type SeedLesson = {
  id: string;
  title: string;
  description: string;
  item: SeedLessonItem;
  dictionaryEntries: SeedLessonDictionaryEntry[];
};

const seedVocabularyEntries: SeedVocabularyEntry[] = [
  {
    id: 'vocab-wake-up',
    englishText: 'wake up',
    kind: 'PHRASE',
    notes: 'Daily routine action',
    tags: ['daily-routine'],
    translations: [{ languageCode: 'am', translation: 'արթնանալ' }],
  },
  {
    id: 'vocab-brush-my-teeth',
    englishText: 'brush my teeth',
    kind: 'PHRASE',
    notes: 'Daily routine action',
    tags: ['daily-routine'],
    translations: [{ languageCode: 'am', translation: 'ատամներս լվանալ' }],
  },
  {
    id: 'vocab-make-breakfast',
    englishText: 'make breakfast',
    kind: 'PHRASE',
    notes: 'Daily routine action',
    tags: ['daily-routine'],
    translations: [{ languageCode: 'am', translation: 'նախաճաշ պատրաստել' }],
  },
  {
    id: 'vocab-go-to-work',
    englishText: 'go to work',
    kind: 'PHRASE',
    notes: 'Daily routine action',
    tags: ['daily-routine'],
    translations: [{ languageCode: 'am', translation: 'գնալ աշխատանքի' }],
  },
  {
    id: 'vocab-daily-routine',
    englishText: 'daily routine',
    kind: 'PHRASE',
    notes: 'Topic phrase',
    tags: ['daily-routine'],
    translations: [{ languageCode: 'am', translation: 'օրյա առօրյա' }],
  },
  {
    id: 'vocab-grocery-store',
    englishText: 'grocery store',
    kind: 'PHRASE',
    notes: 'Shopping topic phrase',
    tags: ['grocery-store'],
    translations: [{ languageCode: 'am', translation: 'մթերային խանութ' }],
  },
  {
    id: 'vocab-milk',
    englishText: 'milk',
    kind: 'WORD',
    notes: 'Shopping topic word',
    tags: ['grocery-store'],
    translations: [{ languageCode: 'am', translation: 'կաթ' }],
  },
  {
    id: 'vocab-bread',
    englishText: 'bread',
    kind: 'WORD',
    notes: 'Shopping topic word',
    tags: ['grocery-store'],
    translations: [{ languageCode: 'am', translation: 'հաց' }],
  },
  {
    id: 'vocab-fruit',
    englishText: 'fruit',
    kind: 'WORD',
    notes: 'Shopping topic word',
    tags: ['grocery-store'],
    translations: [{ languageCode: 'am', translation: 'միրգ' }],
  },
  {
    id: 'vocab-cashier',
    englishText: 'cashier',
    kind: 'WORD',
    notes: 'Shopping topic word',
    tags: ['grocery-store'],
    translations: [{ languageCode: 'am', translation: 'դրամարկղի աշխատող' }],
  },
  {
    id: 'vocab-best-friend',
    englishText: 'best friend',
    kind: 'PHRASE',
    notes: 'Friendship topic phrase',
    tags: ['best-friend'],
    translations: [{ languageCode: 'am', translation: 'լավագույն ընկեր' }],
  },
  {
    id: 'vocab-kind',
    englishText: 'kind',
    kind: 'WORD',
    notes: 'Friendship topic word',
    tags: ['best-friend'],
    translations: [{ languageCode: 'am', translation: 'բարի' }],
  },
  {
    id: 'vocab-funny',
    englishText: 'funny',
    kind: 'WORD',
    notes: 'Friendship topic word',
    tags: ['best-friend'],
    translations: [{ languageCode: 'am', translation: 'զվարճալի' }],
  },
  {
    id: 'vocab-trust',
    englishText: 'trust',
    kind: 'WORD',
    notes: 'Friendship topic word',
    tags: ['best-friend'],
    translations: [{ languageCode: 'am', translation: 'վստահել' }],
  },
  {
    id: 'vocab-dreams',
    englishText: 'dreams',
    kind: 'WORD',
    notes: 'Friendship topic word',
    tags: ['best-friend'],
    translations: [{ languageCode: 'am', translation: 'երազանքներ' }],
  },
  {
    id: 'vocab-park',
    englishText: 'park',
    kind: 'WORD',
    notes: 'Park topic word',
    tags: ['park'],
    translations: [{ languageCode: 'am', translation: 'այգի' }],
  },
  {
    id: 'vocab-sunny',
    englishText: 'sunny',
    kind: 'WORD',
    notes: 'Park topic word',
    tags: ['park'],
    translations: [{ languageCode: 'am', translation: 'արևոտ' }],
  },
  {
    id: 'vocab-fresh-air',
    englishText: 'fresh air',
    kind: 'PHRASE',
    notes: 'Park topic phrase',
    tags: ['park'],
    translations: [{ languageCode: 'am', translation: 'մաքուր օդ' }],
  },
  {
    id: 'vocab-ice-cream',
    englishText: 'ice cream',
    kind: 'PHRASE',
    notes: 'Park topic phrase',
    tags: ['park'],
    translations: [{ languageCode: 'am', translation: 'պաղպաղակ' }],
  },
  {
    id: 'vocab-calm',
    englishText: 'calm',
    kind: 'WORD',
    notes: 'Park topic word',
    tags: ['park'],
    translations: [{ languageCode: 'am', translation: 'հանգիստ' }],
  },
  {
    id: 'vocab-learn-english',
    englishText: 'learn English',
    kind: 'PHRASE',
    notes: 'Language learning phrase',
    tags: ['learning-english'],
    translations: [{ languageCode: 'am', translation: 'անգլերեն սովորել' }],
  },
  {
    id: 'vocab-new-words',
    englishText: 'new words',
    kind: 'PHRASE',
    notes: 'Language learning phrase',
    tags: ['learning-english'],
    translations: [{ languageCode: 'am', translation: 'նոր բառեր' }],
  },
  {
    id: 'vocab-mistakes',
    englishText: 'mistakes',
    kind: 'WORD',
    notes: 'Language learning word',
    tags: ['learning-english'],
    translations: [{ languageCode: 'am', translation: 'սխալներ' }],
  },
  {
    id: 'vocab-fluently',
    englishText: 'fluently',
    kind: 'WORD',
    notes: 'Language learning word',
    tags: ['learning-english'],
    translations: [{ languageCode: 'am', translation: 'սահուն' }],
  },
  {
    id: 'vocab-useful',
    englishText: 'useful',
    kind: 'WORD',
    notes: 'Language learning word',
    tags: ['learning-english'],
    translations: [{ languageCode: 'am', translation: 'օգտակար' }],
  },
];

const seedLessonDefinitions: SeedLesson[] = [
  {
    id: 'seed-lesson-1',
    title: 'Daily Routine',
    description: 'A simple lesson about everyday habits and routines.',
    item: {
      id: 'seed-item-1',
      order: 0,
      text: 'Hello! My name is Anna. I wake up every day at 7 o’clock in the morning. First, I brush my teeth and wash my face. Then I make breakfast. I usually eat eggs and drink coffee. After breakfast, I go to work. I work in an office. I like my job because I talk to many people. In the evening, I come home and cook dinner. I sometimes watch TV or read a book. On weekends, I meet my friends or go for a walk in the park. I enjoy simple things in life. My daily routine is not very exciting, but it makes me happy and relaxed.',
      audioUrl: '',
      segments: [
        { id: 'seg-daily-routine-1', text: 'Hello! My name is Anna.', startMs: 0, endMs: 2600 },
        { id: 'seg-daily-routine-2', text: 'I wake up every day at 7 o’clock in the morning.', startMs: 2600, endMs: 7600 },
        { id: 'seg-daily-routine-3', text: 'First, I brush my teeth and wash my face. Then I make breakfast.', startMs: 7600, endMs: 13800 },
        { id: 'seg-daily-routine-4', text: 'After breakfast, I go to work.', startMs: 13800, endMs: 16800 },
        { id: 'seg-daily-routine-5', text: 'My daily routine is not very exciting, but it makes me happy and relaxed.', startMs: 16800, endMs: 23000 },
      ],
    },
    dictionaryEntries: [
      { entryId: 'vocab-wake-up', order: 0, sourceItemId: 'seed-item-1' },
      { entryId: 'vocab-brush-my-teeth', order: 1, sourceItemId: 'seed-item-1' },
      { entryId: 'vocab-make-breakfast', order: 2, sourceItemId: 'seed-item-1' },
      { entryId: 'vocab-go-to-work', order: 3, sourceItemId: 'seed-item-1' },
      { entryId: 'vocab-daily-routine', order: 4, sourceItemId: 'seed-item-1' },
    ],
  },
  {
    id: 'seed-lesson-2',
    title: 'At the Grocery Store',
    description: 'A practical lesson about buying food and shopping at a grocery store.',
    item: {
      id: 'seed-item-2',
      order: 0,
      text: 'Today I go to the grocery store to buy some food. I need milk, bread, eggs, and fruit. The store is not far from my house, so I walk there. Inside the store, there are many people. I take a basket and start shopping. First, I go to the fruit section and pick apples and bananas. Then I go to the dairy section and take milk and cheese. I also buy some vegetables like tomatoes and cucumbers. At the end, I go to the cashier and pay for everything. The cashier is friendly and says “Have a nice day!” I smile and go back home.',
      audioUrl: '',
      segments: [
        { id: 'seg-grocery-1', text: 'Today I go to the grocery store to buy some food.', startMs: 0, endMs: 4200 },
        { id: 'seg-grocery-2', text: 'I need milk, bread, eggs, and fruit.', startMs: 4200, endMs: 7300 },
        { id: 'seg-grocery-3', text: 'I take a basket and start shopping.', startMs: 7300, endMs: 10300 },
        { id: 'seg-grocery-4', text: 'At the end, I go to the cashier and pay for everything.', startMs: 10300, endMs: 15000 },
        { id: 'seg-grocery-5', text: 'I smile and go back home.', startMs: 15000, endMs: 17600 },
      ],
    },
    dictionaryEntries: [
      { entryId: 'vocab-grocery-store', order: 0, sourceItemId: 'seed-item-2' },
      { entryId: 'vocab-milk', order: 1, sourceItemId: 'seed-item-2' },
      { entryId: 'vocab-bread', order: 2, sourceItemId: 'seed-item-2' },
      { entryId: 'vocab-fruit', order: 3, sourceItemId: 'seed-item-2' },
      { entryId: 'vocab-cashier', order: 4, sourceItemId: 'seed-item-2' },
    ],
  },
  {
    id: 'seed-lesson-3',
    title: 'My Best Friend',
    description: 'A personal lesson about friendship, trust, and shared time.',
    item: {
      id: 'seed-item-3',
      order: 0,
      text: 'My best friend’s name is Mark. We have known each other for many years. We met at school when we were children. Mark is very kind and funny. He always makes me laugh. We like to spend time together. Sometimes we go to the cinema or play sports. Mark likes football, and I like basketball, but we enjoy both games. We also like to talk about our plans and dreams. I trust him, and he trusts me. A good friend is very important in life. I am happy to have a friend like Mark.',
      audioUrl: '',
      segments: [
        { id: 'seg-friend-1', text: 'My best friend’s name is Mark.', startMs: 0, endMs: 2900 },
        { id: 'seg-friend-2', text: 'Mark is very kind and funny.', startMs: 2900, endMs: 5600 },
        { id: 'seg-friend-3', text: 'We like to spend time together.', startMs: 5600, endMs: 8200 },
        { id: 'seg-friend-4', text: 'We also like to talk about our plans and dreams.', startMs: 8200, endMs: 12400 },
        { id: 'seg-friend-5', text: 'I trust him, and he trusts me.', startMs: 12400, endMs: 15200 },
      ],
    },
    dictionaryEntries: [
      { entryId: 'vocab-best-friend', order: 0, sourceItemId: 'seed-item-3' },
      { entryId: 'vocab-kind', order: 1, sourceItemId: 'seed-item-3' },
      { entryId: 'vocab-funny', order: 2, sourceItemId: 'seed-item-3' },
      { entryId: 'vocab-trust', order: 3, sourceItemId: 'seed-item-3' },
      { entryId: 'vocab-dreams', order: 4, sourceItemId: 'seed-item-3' },
    ],
  },
  {
    id: 'seed-lesson-4',
    title: 'A Visit to the Park',
    description: 'A calm lesson about visiting the park and enjoying nature.',
    item: {
      id: 'seed-item-4',
      order: 0,
      text: 'Yesterday, I went to the park near my house. The weather was sunny and warm. Many people were there. Some people were walking their dogs, and others were sitting on benches. I saw children playing and laughing. I decided to walk around and enjoy the fresh air. There were many trees and flowers. I sat on the grass and listened to music. It was very relaxing. After some time, I bought an ice cream from a the park. It was a perfect day. I like going to the park because it helps me feel calm and happy.',
      audioUrl: '',
      segments: [
        { id: 'seg-park-1', text: 'Yesterday, I went to the park near my house.', startMs: 0, endMs: 3600 },
        { id: 'seg-park-2', text: 'The weather was sunny and warm.', startMs: 3600, endMs: 6100 },
        { id: 'seg-park-3', text: 'I decided to walk around and enjoy the fresh air.', startMs: 6100, endMs: 10600 },
        { id: 'seg-park-4', text: 'After some time, I bought an ice cream.', startMs: 10600, endMs: 13800 },
        { id: 'seg-park-5', text: 'I like going to the park because it helps me feel calm and happy.', startMs: 13800, endMs: 19400 },
      ],
    },
    dictionaryEntries: [
      { entryId: 'vocab-park', order: 0, sourceItemId: 'seed-item-4' },
      { entryId: 'vocab-sunny', order: 1, sourceItemId: 'seed-item-4' },
      { entryId: 'vocab-fresh-air', order: 2, sourceItemId: 'seed-item-4' },
      { entryId: 'vocab-ice-cream', order: 3, sourceItemId: 'seed-item-4' },
      { entryId: 'vocab-calm', order: 4, sourceItemId: 'seed-item-4' },
    ],
  },
  {
    id: 'seed-lesson-5',
    title: 'Learning English',
    description: 'A lesson about motivation, practice, and learning English step by step.',
    item: {
      id: 'seed-item-5',
      order: 0,
      text: 'I am learning English because I want to speak with people from different countries. Every day, I study new words and practice speaking. Sometimes I watch videos or listen to music in English. It helps me understand better. I also try to read simple books. At first, it was difficult, but now it is easier. I am not afraid to make mistakes because mistakes help me learn. My goal is to speak English fluently. I know it takes time, but I am patient. Learning a new language is interesting and useful for my future.',
      audioUrl: '',
      segments: [
        { id: 'seg-english-1', text: 'I am learning English because I want to speak with people from different countries.', startMs: 0, endMs: 5200 },
        { id: 'seg-english-2', text: 'Every day, I study new words and practice speaking.', startMs: 5200, endMs: 8700 },
        { id: 'seg-english-3', text: 'At first, it was difficult, but now it is easier.', startMs: 8700, endMs: 12500 },
        { id: 'seg-english-4', text: 'I am not afraid to make mistakes because mistakes help me learn.', startMs: 12500, endMs: 17600 },
        { id: 'seg-english-5', text: 'My goal is to speak English fluently.', startMs: 17600, endMs: 20500 },
      ],
    },
    dictionaryEntries: [
      { entryId: 'vocab-learn-english', order: 0, sourceItemId: 'seed-item-5' },
      { entryId: 'vocab-new-words', order: 1, sourceItemId: 'seed-item-5' },
      { entryId: 'vocab-mistakes', order: 2, sourceItemId: 'seed-item-5' },
      { entryId: 'vocab-fluently', order: 3, sourceItemId: 'seed-item-5' },
      { entryId: 'vocab-useful', order: 4, sourceItemId: 'seed-item-5' },
    ],
  },
];

const legacyVocabularyTermsToRemove = ['nice to meet you'];

const autoVocabularyTranslationsAm: Record<string, string> = {
  about: 'մասին',
  afraid: 'վախեցած',
  after: 'հետո',
  air: 'օդ',
  also: 'նաև',
  always: 'միշտ',
  anna: 'Աննա',
  apples: 'խնձորներ',
  around: 'շուրջ',
  back: 'հետ',
  bananas: 'բանաններ',
  basket: 'զամբյուղ',
  basketball: 'բասկետբոլ',
  because: 'որովհետև',
  benches: 'նստարաններ',
  best: 'լավագույն',
  better: 'ավելի լավ',
  book: 'գիրք',
  books: 'գրքեր',
  both: 'երկուսն էլ',
  bought: 'գնեց',
  bread: 'հաց',
  breakfast: 'նախաճաշ',
  brush: 'մաքրել',
  buy: 'գնել',
  calm: 'հանգիստ',
  cashier: 'դրամարկղի աշխատող',
  cheese: 'պանիր',
  children: 'երեխաներ',
  cinema: 'կինոթատրոն',
  coffee: 'սուրճ',
  come: 'գալ',
  cook: 'պատրաստել',
  countries: 'երկրներ',
  cream: 'կրեմ',
  cucumbers: 'վարունգներ',
  daily: 'ամենօրյա',
  dairy: 'կաթնամթերք',
  day: 'օր',
  decided: 'որոշեց',
  different: 'տարբեր',
  difficult: 'դժվար',
  dinner: 'ընթրիք',
  dogs: 'շներ',
  dreams: 'երազանքներ',
  drink: 'խմել',
  each: 'յուրաքանչյուր',
  easier: 'ավելի հեշտ',
  eat: 'ուտել',
  eggs: 'ձվեր',
  end: 'վերջ',
  english: 'անգլերեն',
  enjoy: 'վայելել',
  evening: 'երեկո',
  every: 'ամեն',
  everything: 'ամեն ինչ',
  exciting: 'հուզիչ',
  face: 'դեմք',
  far: 'հեռու',
  feel: 'զգալ',
  first: 'առաջին',
  flowers: 'ծաղիկներ',
  fluently: 'սահուն',
  food: 'սնունդ',
  football: 'ֆուտբոլ',
  fresh: 'թարմ',
  friend: 'ընկեր',
  friendly: 'ընկերասեր',
  friends: 'ընկերներ',
  fruit: 'միրգ',
  funny: 'զվարճալի',
  future: 'ապագա',
  games: 'խաղեր',
  go: 'գնալ',
  goal: 'նպատակ',
  going: 'գնալ',
  good: 'լավ',
  grass: 'խոտ',
  grocery: 'մթերք',
  happy: 'երջանիկ',
  have: 'ունենալ',
  hello: 'բարև',
  help: 'օգնել',
  helps: 'օգնում է',
  home: 'տուն',
  house: 'տուն',
  important: 'կարևոր',
  inside: 'ներսում',
  interesting: 'հետաքրքիր',
  job: 'աշխատանք',
  kind: 'բարի',
  know: 'իմանալ',
  known: 'ճանաչել',
  language: 'լեզու',
  laugh: 'ծիծաղել',
  laughing: 'ծիծաղող',
  learn: 'սովորել',
  learning: 'սովորում',
  life: 'կյանք',
  like: 'հավանել',
  likes: 'հավանում է',
  listen: 'լսել',
  listened: 'լսեց',
  make: 'պատրաստել',
  makes: 'դարձնում է',
  many: 'շատ',
  mark: 'Մարկ',
  meet: 'հանդիպել',
  met: 'հանդիպեց',
  milk: 'կաթ',
  mistakes: 'սխալներ',
  morning: 'առավոտ',
  music: 'երաժշտություն',
  name: 'անուն',
  near: 'մոտ',
  need: 'կարիք ունենալ',
  new: 'նոր',
  nice: 'հաճելի',
  now: 'հիմա',
  office: 'գրասենյակ',
  other: 'այլ',
  others: 'ուրիշներ',
  our: 'մեր',
  park: 'այգի',
  patient: 'համբերատար',
  pay: 'վճարել',
  people: 'մարդիկ',
  perfect: 'կատարյալ',
  pick: 'ընտրել',
  plans: 'ծրագրեր',
  play: 'խաղալ',
  playing: 'խաղում',
  practice: 'վարժվել',
  read: 'կարդալ',
  relaxed: 'հանգստացած',
  relaxing: 'հանգստացնող',
  routine: 'առօրյա',
  sat: 'նստեց',
  saw: 'տեսավ',
  says: 'ասում է',
  school: 'դպրոց',
  section: 'բաժին',
  shopping: 'գնումներ',
  simple: 'պարզ',
  sitting: 'նստած',
  smile: 'ժպտալ',
  some: 'մի քանի',
  sometimes: 'երբեմն',
  speak: 'խոսել',
  speaking: 'խոսել',
  spend: 'անցկացնել',
  sports: 'սպորտ',
  start: 'սկսել',
  store: 'խանութ',
  study: 'սովորել',
  sunny: 'արևոտ',
  take: 'վերցնել',
  takes: 'վերցնում է',
  talk: 'խոսել',
  teeth: 'ատամներ',
  their: 'իրենց',
  then: 'հետո',
  there: 'այնտեղ',
  things: 'բաներ',
  time: 'ժամանակ',
  today: 'այսօր',
  together: 'միասին',
  tomatoes: 'լոլիկներ',
  trees: 'ծառեր',
  trust: 'վստահել',
  trusts: 'վստահում է',
  try: 'փորձել',
  tv: 'հեռուստացույց',
  understand: 'հասկանալ',
  up: 'վեր',
  useful: 'օգտակար',
  usually: 'սովորաբար',
  vegetables: 'բանջարեղեն',
  very: 'շատ',
  videos: 'տեսանյութեր',
  wake: 'արթնանալ',
  walk: 'քայլել',
  walking: 'քայլում',
  want: 'ցանկանալ',
  warm: 'տաք',
  wash: 'լվանալ',
  watch: 'դիտել',
  weather: 'եղանակ',
  weekends: 'հանգստյան օրեր',
  went: 'գնաց',
  when: 'երբ',
  words: 'բառեր',
  work: 'աշխատանք',
  years: 'տարիներ',
  yesterday: 'երեկ',
};

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
  for (const seedLesson of seedLessonDefinitions) {
    const lesson = await prisma.lesson.upsert({
      where: { id: seedLesson.id },
      update: {
        title: seedLesson.title,
        description: seedLesson.description,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        authorId,
      },
      create: {
        id: seedLesson.id,
        title: seedLesson.title,
        description: seedLesson.description,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        authorId,
      },
    });

    await prisma.lessonItem.deleteMany({ where: { lessonId: lesson.id } });

    await prisma.lessonItem.create({
      data: {
        id: seedLesson.item.id,
        lessonId: lesson.id,
        order: seedLesson.item.order,
        text: seedLesson.item.text,
        audioUrl: seedLesson.item.audioUrl,
        segments: seedLesson.item.segments as Prisma.InputJsonValue,
      },
    });
  }

  console.log(`Seeded ${seedLessonDefinitions.length} lessons with one text-audio item each.`);
}

async function seedVocabulary(authorId: string) {
  if (legacyVocabularyTermsToRemove.length) {
    await prisma.vocabularyEntry.deleteMany({
      where: {
        OR: legacyVocabularyTermsToRemove.map((term) => ({
          englishText: {
            equals: canonicalizeVocabularyText(term),
            mode: 'insensitive',
          },
        })),
      },
    });
  }

  for (const item of seedVocabularyEntries) {
    const englishText = canonicalizeVocabularyText(item.englishText);
    const existingEntry = await prisma.vocabularyEntry.findFirst({
      where: {
        englishText: {
          equals: englishText,
          mode: 'insensitive',
        },
      },
    });

    const vocabularyEntry = existingEntry
      ? await prisma.vocabularyEntry.update({
          where: { id: existingEntry.id },
          data: {
            englishText,
            kind: item.kind,
            notes: item.notes,
            tags: item.tags ?? [],
            createdById: existingEntry.createdById ?? authorId,
          },
        })
      : await prisma.vocabularyEntry.create({
          data: {
            englishText,
            kind: item.kind,
            notes: item.notes,
            tags: item.tags ?? [],
            createdById: authorId,
          },
        });

    await prisma.vocabularyTranslation.deleteMany({
      where: { entryId: vocabularyEntry.id },
    });

    await prisma.vocabularyTranslation.createMany({
      data: item.translations.map((translation) => ({
        entryId: vocabularyEntry.id,
        languageCode: translation.languageCode,
        translation: translation.translation,
        usageExample: translation.usageExample,
      })),
    });
  }

  console.log('Seeded vocabulary entries with translations.');
}

async function seedAutoVocabularyTranslations() {
  for (const [englishText, translation] of Object.entries(autoVocabularyTranslationsAm)) {
    const entry = await prisma.vocabularyEntry.findFirst({
      where: {
        englishText: {
          equals: canonicalizeVocabularyText(englishText),
          mode: 'insensitive',
        },
      },
    });

    if (!entry) {
      continue;
    }

    const existingTranslation = await prisma.vocabularyTranslation.findFirst({
      where: {
        entryId: entry.id,
        languageCode: 'am',
      },
    });

    if (existingTranslation) {
      await prisma.vocabularyTranslation.update({
        where: { id: existingTranslation.id },
        data: { translation },
      });
      continue;
    }

    await prisma.vocabularyTranslation.create({
      data: {
        entryId: entry.id,
        languageCode: 'am',
        translation,
      },
    });
  }

  console.log('Seeded Armenian translations for auto-ingested lesson words.');
}

async function main() {
  const admin = await seedAdmin();
  await seedMobileUser();
  await seedLessons(admin.id);
  await ensureVocabularyEntriesForLessonTexts(
    prisma,
    seedLessonDefinitions.map((lesson) => lesson.item.text),
    admin.id,
  );
  await seedVocabulary(admin.id);
  await seedAutoVocabularyTranslations();
  await prisma.appSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global' },
    update: {},
  });
  console.log('App settings seeded.');
}

main()
  .catch((error) => {
    console.error('Failed to seed initial data', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

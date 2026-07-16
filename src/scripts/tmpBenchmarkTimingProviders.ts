/*
 TEMPORARY SCRIPT.
 Purpose: compare current OpenAI Whisper timing generation vs DashScope Qwen file transcription
 for the same lesson audio and lesson text.
 Delete after benchmarking is complete.
*/

import fs from 'fs';
import path from 'path';

import {
  getTimingTranscriptionProvider,
  transcribeAudioWithWordTimestamps,
  type AudioTranscriptionResult,
  type TimingTranscriptionProvider,
} from '../lib/audioTranscription';
import { generateLessonTimingsFromTranscript } from '../lib/lessonTimingAlignment';

interface BenchmarkArgs {
  audioPath: string;
  audioUrl?: string;
  lessonText?: string;
  lessonTextFile?: string;
  jsonOut?: string;
}

interface ProviderBenchmarkResult {
  provider: TimingTranscriptionProvider;
  ok: boolean;
  error?: string;
  transcription?: AudioTranscriptionResult;
  timingSummary?: ReturnType<typeof buildTimingSummary>;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (hasFlag(process.argv.slice(2), '--help') || hasFlag(process.argv.slice(2), '-h')) {
    printHelp();
    return;
  }

  validateArgs(args);

  const lessonText = await resolveLessonText(args);
  const originalProvider = process.env.TIMING_TRANSCRIPTION_PROVIDER;
  const startedAt = new Date().toISOString();

  const providers: TimingTranscriptionProvider[] = [
    'openai-whisper',
    'dashscope-qwen-filetrans',
  ];

  const results: ProviderBenchmarkResult[] = [];

  for (const provider of providers) {
    const result = await benchmarkProvider({
      provider,
      audioPath: args.audioPath,
      audioUrl: args.audioUrl,
      lessonText,
    });
    results.push(result);
  }

  if (originalProvider === undefined) {
    delete process.env.TIMING_TRANSCRIPTION_PROVIDER;
  } else {
    process.env.TIMING_TRANSCRIPTION_PROVIDER = originalProvider;
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    audioPath: path.resolve(args.audioPath),
    audioUrl: args.audioUrl ?? null,
    lessonTextLength: lessonText.length,
    defaultConfiguredProvider: getTimingTranscriptionProvider(),
    results,
  };

  if (args.jsonOut) {
    const outputPath = path.resolve(args.jsonOut);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  printHumanReport(report, args.jsonOut);
}

async function benchmarkProvider({
  provider,
  audioPath,
  audioUrl,
  lessonText,
}: {
  provider: TimingTranscriptionProvider;
  audioPath: string;
  audioUrl?: string;
  lessonText: string;
}): Promise<ProviderBenchmarkResult> {
  try {
    const transcription = await transcribeAudioWithWordTimestamps({
      audioPath,
      audioUrl,
      prompt: lessonText,
      provider,
    });

    const generated = generateLessonTimingsFromTranscript({
      lessonText,
      transcriptText: transcription.text,
      transcriptWords: transcription.words,
      audioDurationSeconds: transcription.audioDurationSeconds,
    });

    return {
      provider,
      ok: true,
      transcription,
      timingSummary: buildTimingSummary(generated),
    };
  } catch (error) {
    return {
      provider,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTimingSummary(generated: ReturnType<typeof generateLessonTimingsFromTranscript>) {
  const estimatedWarnings = generated.warnings.filter((warning) =>
    warning.startsWith('Estimated audio timestamp for '),
  );

  return {
    transcriptPreview: generated.transcriptText.slice(0, 240),
    wordTimingCount: generated.wordTimings.length,
    sentenceTimingCount: generated.sentenceTimings.length,
    segmentCount: generated.segments.length,
    warningCount: generated.warnings.length,
    estimatedWordCount: estimatedWarnings.length,
    warnings: generated.warnings,
    firstWordTiming: generated.wordTimings[0]
      ? {
          text: generated.wordTimings[0].text,
          startMs: generated.wordTimings[0].startMs,
          endMs: generated.wordTimings[0].endMs,
        }
      : null,
    lastWordTiming: generated.wordTimings.at(-1)
      ? {
          text: generated.wordTimings.at(-1)?.text ?? '',
          startMs: generated.wordTimings.at(-1)?.startMs ?? 0,
          endMs: generated.wordTimings.at(-1)?.endMs ?? 0,
        }
      : null,
  };
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = { audioPath: '' };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case '--audio-path':
        args.audioPath = requireNextValue(token, next);
        index += 1;
        break;
      case '--audio-url':
        args.audioUrl = requireNextValue(token, next);
        index += 1;
        break;
      case '--lesson-text':
        args.lessonText = requireNextValue(token, next);
        index += 1;
        break;
      case '--lesson-text-file':
        args.lessonTextFile = requireNextValue(token, next);
        index += 1;
        break;
      case '--json-out':
        args.jsonOut = requireNextValue(token, next);
        index += 1;
        break;
      case '--help':
      case '-h':
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Unknown flag: ${token}`);
        }
        throw new Error(`Unexpected positional argument: ${token}`);
    }
  }

  return args;
}

function hasFlag(argv: string[], flag: string) {
  return argv.includes(flag);
}

function requireNextValue(flag: string, value: string | undefined) {
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function validateArgs(args: BenchmarkArgs) {
  if (!args.audioPath) {
    throw new Error('--audio-path is required');
  }

  if (!args.lessonText && !args.lessonTextFile) {
    throw new Error('Either --lesson-text or --lesson-text-file is required');
  }

  if (args.lessonText && args.lessonTextFile) {
    throw new Error('Use only one of --lesson-text or --lesson-text-file');
  }
}

async function resolveLessonText(args: BenchmarkArgs) {
  if (args.lessonText !== undefined) {
    return args.lessonText;
  }

  const lessonTextFile = path.resolve(String(args.lessonTextFile));
  return fs.promises.readFile(lessonTextFile, 'utf8');
}

function printHumanReport(
  report: {
    startedAt: string;
    finishedAt: string;
    audioPath: string;
    audioUrl: string | null;
    lessonTextLength: number;
    defaultConfiguredProvider: TimingTranscriptionProvider;
    results: ProviderBenchmarkResult[];
  },
  jsonOut?: string,
) {
  console.log('Temporary timing benchmark');
  console.log(`Started: ${report.startedAt}`);
  console.log(`Finished: ${report.finishedAt}`);
  console.log(`Audio path: ${report.audioPath}`);
  console.log(`Audio URL: ${report.audioUrl ?? '(not provided)'}`);
  console.log(`Lesson text length: ${report.lessonTextLength}`);
  console.log(`Configured default provider after run: ${report.defaultConfiguredProvider}`);
  console.log('');

  for (const result of report.results) {
    console.log(`Provider: ${result.provider}`);
    console.log(`Status: ${result.ok ? 'ok' : 'failed'}`);

    if (!result.ok) {
      console.log(`Error: ${result.error}`);
      console.log('');
      continue;
    }

    console.log(`Transcript words returned: ${result.transcription?.words.length ?? 0}`);
    console.log(`Audio duration seconds: ${result.transcription?.audioDurationSeconds ?? 'n/a'}`);
    console.log(`Warnings: ${result.timingSummary?.warningCount ?? 0}`);
    console.log(`Estimated words: ${result.timingSummary?.estimatedWordCount ?? 0}`);
    console.log(`Sentence timings: ${result.timingSummary?.sentenceTimingCount ?? 0}`);
    console.log(`First word timing: ${formatWordTiming(result.timingSummary?.firstWordTiming)}`);
    console.log(`Last word timing: ${formatWordTiming(result.timingSummary?.lastWordTiming)}`);
    console.log(`Transcript preview: ${JSON.stringify(result.timingSummary?.transcriptPreview ?? '')}`);

    if ((result.timingSummary?.warnings.length ?? 0) > 0) {
      console.log('Warnings detail:');
      for (const warning of result.timingSummary?.warnings ?? []) {
        console.log(`- ${warning}`);
      }
    }

    console.log('');
  }

  if (jsonOut) {
    console.log(`JSON report written to: ${path.resolve(jsonOut)}`);
  }

  console.log('Reminder: this is a temporary benchmarking script and should be deleted after comparison work is complete.');
}

function formatWordTiming(
  timing:
    | {
        text: string;
        startMs: number;
        endMs: number;
      }
    | null
    | undefined,
) {
  if (!timing) {
    return 'n/a';
  }

  return `${timing.text} (${timing.startMs}-${timing.endMs} ms)`;
}

function printHelp() {
  console.log(`Usage:
  node dist/scripts/tmpBenchmarkTimingProviders.js \
    --audio-path /absolute/path/to/audio.mp3 \
    --audio-url /media/audio/file.mp3 \
    --lesson-text-file /absolute/path/to/text.txt \
    --json-out /absolute/path/to/report.json

Required:
  --audio-path        Local stored audio file path used by the OpenAI path
  --lesson-text       Inline lesson text to align against
  --lesson-text-file  File containing lesson text to align against

Optional:
  --audio-url         Stored/public audio URL needed by DashScope Qwen file transcription
  --json-out          Write full comparison report as JSON
  --help, -h          Show this help

Notes:
- DashScope Qwen comparison requires:
  TIMING_TRANSCRIPTION_PROVIDER is set by the script per provider.
  DASHSCOPE_API_KEY
  DASHSCOPE_WORKSPACE_ID
  APP_BASE_URL pointing to a publicly reachable backend origin
- OpenAI comparison requires OPENAI_API_KEY
- This script is temporary and should be deleted after benchmarking.
`);
}

main().catch((error) => {
  console.error('Temporary timing benchmark failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

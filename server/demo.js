// Builds a fictional demo hearing with real synthesized audio so playback,
// timestamps and click-to-seek can be tried without a microphone. On Windows
// the speech comes from the built-in System.Speech voices; elsewhere (or if
// synthesis fails) each line becomes silence of a plausible length.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.js';
import * as svc from './transcript.js';

const run = promisify(execFile);
const RATE = 16000;
const GAP_MS = 650;

const SPEAKERS = [
  { label: 'THE COURT', role: 'Judge', voice: 0 },
  { label: 'THE CLERK', role: 'Clerk', voice: 1 },
  { label: 'MS. OKAFOR', role: 'Prosecution', voice: 1 },
  { label: 'MR. LINDQVIST', role: 'Defense', voice: 0 },
  { label: 'THE WITNESS', role: 'Witness', voice: 2 },
];

const SCRIPT = [
  [1, 'All rise. Department twelve is now in session, the Honorable Judge Ramirez presiding.'],
  [0, 'Please be seated. We are on the record in State versus Marlowe, case number C R twenty-six, zero four one eight.'],
  [0, 'Counsel, please state your appearances.'],
  [2, 'Good morning, Your Honor. Adaeze Okafor for the State.'],
  [3, 'Good morning. Erik Lindqvist for the defendant, who is present in court.'],
  [0, 'Thank you. Ms. Okafor, you may call your next witness.'],
  [2, 'The State calls Dana Whitfield.'],
  [1, 'Please raise your right hand. Do you swear the testimony you are about to give is the truth?'],
  [4, 'I do.'],
  [2, 'Ms. Whitfield, where were you on the evening of March fourth?'],
  [4, 'I was closing up the bakery on Alder Street, a little after nine.'],
  [2, 'And what did you see when you stepped outside?'],
  [4, 'A grey van was parked across the alley, and the driver was loading boxes from the warehouse next door.'],
  [3, 'Objection, Your Honor. Foundation. There is no showing the witness could see the alley from the doorway.'],
  [0, 'Sustained. Lay a foundation, counsel.'],
  [2, 'Ms. Whitfield, describe where you were standing and what you could see from there.'],
  [4, 'I was at the side door. It opens straight onto the alley, and the street light was right above the van.'],
  [0, 'The objection is overruled as to that answer. Proceed.'],
];

export async function createDemoHearing({ audio }) {
  const session = await svc.createSession({
    case_number: 'CR-26-0418',
    title: 'State v. Marlowe (demo)',
    courtroom: 'Department 12',
    judge: 'Hon. L. Ramirez',
    speakers: SPEAKERS,
  });
  const speakers = await svc.listSpeakers(session.id);
  const clips = await synthesize(SCRIPT.map(([who, text]) => ({ text, voice: SPEAKERS[who].voice })));

  let cursor = 0; // samples
  const segments = [];
  for (let i = 0; i < SCRIPT.length; i++) {
    const [who, text] = SCRIPT[i];
    const gap = Buffer.alloc(Math.round((GAP_MS / 1000) * RATE) * 2);
    cursor = await audio.write(session.id, cursor, gap, RATE);
    const pcm = clips[i] || Buffer.alloc(Math.round(text.split(/\s+/).length * 0.38 * RATE) * 2);
    const start = cursor;
    cursor = await audio.write(session.id, cursor, pcm, RATE);
    segments.push({
      speaker_id: speakers.find((s) => s.label === SPEAKERS[who].label)?.id ?? null,
      start_ms: Math.round((start / RATE) * 1000),
      end_ms: Math.round((cursor / RATE) * 1000),
      text,
    });
  }
  cursor = await audio.write(session.id, cursor, Buffer.alloc(RATE * 2), RATE);

  for (const seg of segments) await svc.createSegment(session.id, seg, 'import');
  const durationMs = Math.round((cursor / RATE) * 1000);
  await db.query(
    `UPDATE sessions SET status = 'closed', audio_samples = $2,
            started_at = now() - make_interval(secs => $3::float / 1000), ended_at = now(), updated_at = now()
      WHERE id = $1`,
    [session.id, cursor, durationMs],
  );
  return svc.getSession(session.id);
}

async function synthesize(items) {
  if (process.platform !== 'win32') return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courtscribe-tts-'));
  try {
    const jobs = items.map((it, i) => ({ ...it, out: path.join(dir, `${i}.wav`) }));
    const jobsFile = path.join(dir, 'jobs.json');
    const script = path.join(dir, 'tts.ps1');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    fs.writeFileSync(script, `
param([string]$JobsPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$jobs = Get-Content -Raw -LiteralPath $JobsPath | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($job in $jobs) {
  if ($voices.Count -gt 0) { $synth.SelectVoice($voices[[int]$job.voice % $voices.Count]) }
  $synth.SetOutputToWaveFile($job.out, $fmt)
  $synth.Speak([string]$job.text)
  $synth.SetOutputToNull()
}
$synth.Dispose()
`);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-JobsPath', jobsFile], { timeout: 120_000, windowsHide: true });
    return jobs.map((j) => {
      try { return readPcm16kMono(fs.readFileSync(j.out)); } catch { return null; }
    });
  } catch (err) {
    console.warn('Demo speech synthesis unavailable, using silence:', err.message.split('\n')[0]);
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readPcm16kMono(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let fmtOk = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmtOk = buf.readUInt16LE(pos + 8) === 1 && buf.readUInt16LE(pos + 10) === 1
        && buf.readUInt32LE(pos + 12) === RATE && buf.readUInt16LE(pos + 22) === 16;
    } else if (id === 'data') {
      return fmtOk ? buf.subarray(pos + 8, pos + 8 + size) : null;
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

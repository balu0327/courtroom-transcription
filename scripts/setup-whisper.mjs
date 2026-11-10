// One-time setup for server-side Whisper transcription.
// Creates a Python virtual environment in the data directory (outside
// OneDrive on Windows) and installs faster-whisper. With an NVIDIA GPU it
// also installs the CUDA 12 cuBLAS/cuDNN runtime libraries.
//
//   npm run setup:whisper
//
// The model itself (~1.6 GB for large-v3-turbo) downloads on first use.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../server/paths.js';

const venv = path.join(dataDir, 'venv');
const isWin = process.platform === 'win32';
const py = isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

function findPython() {
  for (const cmd of isWin ? ['py', 'python', 'python3'] : ['python3', 'python']) {
    const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0) return cmd === 'py' ? ['py', ['-3']] : [cmd, []];
  }
  console.error('Python 3.9+ is required. Install it from https://www.python.org/ and run this again.');
  process.exit(1);
}

const hasNvidia = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' }).status === 0;

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(py)) {
  const [cmd, pre] = findPython();
  run(cmd, [...pre, '-m', 'venv', venv]);
}
run(py, ['-m', 'pip', 'install', '--upgrade', 'pip']);
run(py, ['-m', 'pip', 'install', 'faster-whisper>=1.1', 'numpy']);
// NVIDIA's own package index serves these large wheels (~1 GB) much faster than PyPI.
if (hasNvidia) run(py, ['-m', 'pip', 'install', '--index-url', 'https://pypi.nvidia.com', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*']);

console.log(`\nWhisper environment ready at ${venv}${hasNvidia ? ' (GPU libraries installed)' : ' (CPU only)'}.`);
console.log('Restart the server; it detects Whisper automatically.');

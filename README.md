# CourtScribe

A courtroom transcription app. It records a hearing in the browser, streams the
audio and a live transcript over WebSockets, attributes every line to a speaker,
keeps each line in sync with the recording, and stores everything in PostgreSQL
with full-text search and an edit audit trail.

```bash
npm install
npm start          # http://127.0.0.1:5050
```

Click **Load demo hearing** to get a fictional hearing with real synthesised
audio (Windows speech voices), so playback, search and editing work without a
microphone. For live recording, use Chrome or Edge on `localhost`.

## Accurate transcription with Whisper (recommended)

The browser's built-in speech recognition is fast but inaccurate, especially
with accents. CourtScribe can instead transcribe on the server with OpenAI's
Whisper model (via `faster-whisper`), running locally: audio never leaves the
machine.

```bash
npm run setup:whisper   # one time: Python venv + faster-whisper (+ CUDA libs with an NVIDIA GPU)
npm start               # the server finds Whisper and loads it
```

Requires Python 3.9+. With an NVIDIA GPU it uses `large-v3-turbo` (about 1.6 GB,
downloaded on first start); without one it uses `small.en` on the CPU.
Override with `WHISPER_MODEL`, `WHISPER_DEVICE=cpu|cuda`, or disable with
`WHISPER=off`.

How live Whisper works (`server/live.js`): the server tracks loudness of the
incoming audio against an adaptive noise floor and cuts it at natural pauses
(or at the quietest moment once a chunk reaches 25 s). Each chunk is
transcribed with word timestamps, and lines are split exactly where the
operator switched speaker. Between cuts the pending audio is re-transcribed
as a live preview. **Re-transcribe with Whisper** in the recorder panel runs a
whole recorded hearing through it again.

## Features and how each is built

| Feature | What it demonstrates | Where |
|---|---|---|
| Audio recording | `getUserMedia` → `AudioWorklet` → 16 kHz 16-bit PCM in 250 ms chunks, with a live level meter | `public/js/recorder.js`, `public/js/pcm-worklet.js` |
| Audio playback | PCM stored raw, served as WAV with a generated header and HTTP `Range` support so the player can seek | `server/audio.js` |
| Live transcript | Web Speech API interim + final results; interim text is broadcast as volatile `partial` messages, final lines as reliable `segment` messages | `public/js/recorder.js`, `server/realtime.js` |
| Speaker identification | `speakers` table per hearing; keys 1–9 switch the active speaker, which is shared by every screen on the hearing (a clerk's laptop can switch it while another device records). With Whisper, lines split at the exact word where the switch happened; click any label to reassign | `server/schema.sql`, `server/live.js`, `public/js/app.js` |
| Timestamps | Every time is milliseconds into the hearing's audio. The sample count is the master clock, so a line's timestamp always points at the same audio. Click a timestamp to play from there; playback highlights and follows the current line; ⇤ re-syncs a line to the playhead | `public/js/app.js` |
| Search | PostgreSQL `tsvector` (generated column + GIN index) with `websearch_to_tsquery` for stemmed matches ("objected" finds "Objection"), plus `ILIKE` for partial words; `ts_headline` marks hits. Per hearing and across all hearings | `server/transcript.js` |
| Save transcript | PostgreSQL: `sessions`, `speakers`, `segments`, `segment_revisions`. Export as a numbered `.txt` transcript | `server/schema.sql`, `server/routes.js` |
| Edit transcript | Full CRUD on lines and speakers. Optimistic concurrency: each save sends the version it was based on; a stale save gets `409` with the other person's text, and the editor keeps your draft. Every change writes the old version to `segment_revisions` with the editor's name | `server/transcript.js`, `public/js/app.js` |
| Reconnection | Backoff with jitter, heartbeat watchdog, instant retry on `online`. Audio frames carry their absolute sample offset and stay queued until acked; lines carry a UUID and stay queued until acked. On reconnect everything is resent; the server drops duplicates, trims overlaps and pads gaps with silence, and `ON CONFLICT (client_id)` makes line inserts idempotent. Viewers resync from the API after every reconnect | `public/js/socket.js`, `server/audio.js` |

Use **Simulate network drop** in the recorder panel to watch the queue fill and
drain.

## Architecture

```
Browser (recorder)                    Node server                         Storage
 mic → AudioWorklet ── PCM frames ──▶  WebSocket hub  ── append ──▶  data/audio/<id>.pcm
 Web Speech ── partial / segment ──▶  (room per hearing) ── SQL ──▶  PostgreSQL
                                        │      ▲
Browser (viewers) ◀── broadcasts ───────┘      └── REST API (CRUD, search, audio, export)
```

**WebSocket protocol** (`/ws`). Client → server: `hello`, `record.start`,
`record.stop`, `partial`, `segment`, `speaker.active`, and binary audio frames
`[float64 sample offset][int16 PCM…]`. Server → client: `hello.ok`, `ack`,
`audio.ack`, `partial`, `segment.created|updated|deleted`, `speaker.*`,
`session.updated`, `presence`, `heartbeat`. Only one connection per hearing
holds the recorder role; the same tab can reclaim it after a reconnect.

**REST API** (`/api`): `GET/POST /sessions`, `GET/PATCH/DELETE /sessions/:id`,
`GET /sessions/:id/audio`, `GET /sessions/:id/export.txt`,
`POST /sessions/:id/speakers`, `PATCH/DELETE /speakers/:id`,
`POST /sessions/:id/segments`, `PATCH/DELETE /segments/:id`,
`GET /segments/:id/revisions`, `GET /search?q=&session_id=`, `POST /demo`,
`GET /health`.

## Database

With no configuration the app uses **PGlite**, the PostgreSQL engine compiled
to WebAssembly. It runs the same SQL as a server, so there is nothing to
install. Data lives in `%LOCALAPPDATA%\CourtScribe` on Windows (kept out of the
project folder because OneDrive locks database files it syncs) and in `./data`
elsewhere. Only one server can use a PGlite database at a time; a second one
exits with a clear message. To use a PostgreSQL server instead:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/courtscribe npm start
```

The schema (`server/schema.sql`) is applied on every start and is idempotent.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5050` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to allow other devices) |
| `DATABASE_URL` | unset | Use a PostgreSQL server instead of PGlite |
| `DATA_DIR` | `%LOCALAPPDATA%\CourtScribe` (Windows), `./data` (others) | Root for the database and recordings |
| `PGLITE_DIR` | `<DATA_DIR>/pgdata` | PGlite data directory |
| `AUDIO_DIR` | `<DATA_DIR>/audio` | Where recordings are stored |
| `WHISPER` | on | `off` disables server-side transcription |
| `WHISPER_MODEL` | `large-v3-turbo` (GPU), `small.en` (CPU) | Whisper model name |
| `WHISPER_DEVICE` | `auto` | `cuda` or `cpu` |
| `WHISPER_VENV` | `<DATA_DIR>/venv` | Python environment with faster-whisper |
| `WHISPER_MODELS_DIR` | `<DATA_DIR>/models` | Where models are downloaded |

## Project layout

```
server/
  index.js        HTTP + WebSocket server bootstrap
  routes.js       REST API
  realtime.js     WebSocket hub: rooms, recorder role, audio frames, shared speaker
  transcript.js   SQL for hearings, speakers, lines, revisions, search
  live.js         Live Whisper pipeline: pause detection, chunking, speaker split
  whisper.js      Manages the Python Whisper worker process and job queue
  audio.js        PCM storage and WAV streaming with Range support
  db.js           PostgreSQL / PGlite connection
  schema.sql      Database schema
  demo.js         Demo hearing with synthesised audio
  paths.js        Data directory location
transcriber/
  worker.py       faster-whisper worker (JSON + PCM over stdin/stdout)
scripts/
  setup-whisper.mjs   One-time Python/Whisper install
public/
  index.html, css/app.css
  js/app.js       UI: hearing list and hearing workspace
  js/socket.js    Reconnecting WebSocket with delivery queue
  js/recorder.js  Microphone capture and browser speech recognition
  js/pcm-worklet.js  AudioWorklet: 16 kHz PCM conversion
  js/util.js      DOM and API helpers
```

## Limitations

- **Browser speech mode** (the fallback when Whisper is not installed): Chrome and Edge send Web Speech audio to
  their vendor's cloud service, which may not be acceptable for sealed or
  sensitive proceedings. The audio pipeline is independent, so a server-side
  engine (for example Whisper reading the stored PCM) could replace it. Firefox
  has no Web Speech support: audio still records and lines can be typed.
- **Sound played through your speakers is usually not transcribed.** The
  browser's recogniser opens its own microphone input with echo cancellation
  always on (pages cannot turn it off), so it filters out audio the computer
  itself is playing. It is still recorded. Speak into the microphone, or play
  test audio from a different device.
- **Timestamps are approximate** for recognised speech (Web Speech gives no word
  timings); start times are estimated from the audio clock when words first
  appear. The ⇤ control corrects a line against playback.
- **Speaker identification is manual** (operator hotkeys), not automatic
  diarisation.
- **No authentication.** It binds to localhost by default; add auth before
  exposing it on a network.
- Microphone access needs `https` or `localhost`.

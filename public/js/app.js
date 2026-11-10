import { $, h, api, clock, wallClock, headlineHtml, debounce, toast, editorName, setEditorName, tabClientId } from './util.js';
import { LiveSocket } from './socket.js';
import { Recorder, speechSupported, TARGET_RATE } from './recorder.js';

const root = $('#app');
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  const [path, qs] = location.hash.slice(1).split('?');
  const m = /^\/session\/([0-9a-f-]{36})$/i.exec(path || '');
  cleanup = m ? SessionView(root, m[1], new URLSearchParams(qs || '')) : HomeView(root);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();

function editorField() {
  return h('label.editor-name', { title: 'Recorded against every edit in the audit trail' },
    h('span', {}, 'Editing as'),
    h('input', {
      value: editorName(), placeholder: 'Your name', maxlength: 60, 'aria-label': 'Your name for the edit history',
      onchange: (e) => setEditorName(e.target.value.trim()),
    }));
}

// ============================================================================
// Hearings list
// ============================================================================
function HomeView(el) {
  let alive = true;
  const list = h('div.hearing-list', { 'aria-live': 'polite' }, h('p.muted', {}, 'Loading hearings…'));
  const results = h('div.search-results.global');
  const searchInput = h('input.search', { type: 'search', placeholder: 'Search every transcript: words, phrases, "exact quotes"…', 'aria-label': 'Search all transcripts' });

  const dialog = newHearingDialog();
  el.append(
    h('header.topbar',
      h('a.brand', { href: '#/' }, h('span.seal', { 'aria-hidden': 'true' }, '§'), 'CourtScribe'),
      h('div.spacer'),
      editorField()),
    h('main.home',
      h('section.home-head',
        h('div', {}, h('h1', {}, 'Hearings'), h('p.muted', {}, 'Record proceedings, transcribe live, attribute speakers and keep an edit history for every line.')),
        h('div.row',
          h('button.ghost', { onclick: loadDemo }, 'Load demo hearing'),
          h('button.primary', { onclick: () => dialog.showModal() }, '+ New hearing'))),
      h('section.global-search', searchInput, results),
      list),
    dialog,
  );

  async function load() {
    try {
      const rows = await api('/sessions');
      if (!alive) return;
      list.replaceChildren(rows.length ? hearingTable(rows) : h('div.empty',
        h('h2', {}, 'No hearings yet'),
        h('p', {}, 'Create a hearing to start recording, or load the demo to try playback, search and editing without a microphone.')));
    } catch (err) {
      list.replaceChildren(h('p.error', {}, `Could not load hearings: ${err.message}`));
    }
  }

  function hearingTable(rows) {
    return h('table.hearings',
      h('thead', h('tr', ['Case', 'Matter', 'Courtroom', 'Status', 'Recorded', 'Lines', 'Created', ''].map((t) => h('th', {}, t)))),
      h('tbody', rows.map((s) => h('tr', { onclick: (e) => { if (!e.target.closest('button')) location.hash = `#/session/${s.id}`; } },
        h('td.mono', {}, s.case_number),
        h('td', {}, h('a', { href: `#/session/${s.id}` }, s.title), s.judge ? h('div.muted.small', {}, s.judge) : null),
        h('td', {}, s.courtroom || '—'),
        h('td', {}, statusPill(s.status, s.recorder)),
        h('td.mono', {}, clock((s.audio_samples / TARGET_RATE) * 1000)),
        h('td.num', {}, s.segment_count),
        h('td.small', {}, new Date(s.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
        h('td', {}, h('button.icon.danger', {
          title: 'Delete hearing', 'aria-label': `Delete ${s.title}`,
          onclick: async () => {
            if (!confirm(`Delete "${s.title}" with its audio and transcript? This cannot be undone.`)) return;
            await api(`/sessions/${s.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
            load();
          },
        }, '✕')),
      ))));
  }

  async function loadDemo(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Synthesising audio…';
    try {
      const s = await api('/demo', { method: 'POST' });
      location.hash = `#/session/${s.id}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Load demo hearing';
    }
  }

  const runSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (!q) return results.replaceChildren();
    try {
      const hits = await api(`/search?q=${encodeURIComponent(q)}`);
      if (!alive || searchInput.value.trim() !== q) return;
      results.replaceChildren(
        h('p.muted.small', {}, hits.length ? `${hits.length} matching line${hits.length === 1 ? '' : 's'}` : 'No matches'),
        ...hits.slice(0, 50).map((r) => h('a.hit', { href: `#/session/${r.session_id}?seg=${r.id}` },
          h('span.hit-case', {}, `${r.case_number} · ${r.title}`),
          h('span.mono.small', {}, clock(r.start_ms)),
          h('span.hit-text', {}, h('b', { style: { color: r.speaker_color || 'inherit' } }, `${r.speaker_label || 'UNIDENTIFIED'}: `),
            h('span', { html: headlineHtml(r.headline) })))),
      );
    } catch (err) { toast(err.message, 'error'); }
  }, 250);
  searchInput.addEventListener('input', runSearch);

  load();
  const refresh = setInterval(load, 15000);
  return () => { alive = false; clearInterval(refresh); };
}

function newHearingDialog() {
  const form = h('form.dialog-form', { method: 'dialog' },
    h('h2', {}, 'New hearing'),
    field('Case number', h('input', { name: 'case_number', required: true, placeholder: 'CR-26-0001', maxlength: 80 })),
    field('Matter', h('input', { name: 'title', required: true, placeholder: 'State v. Doe', maxlength: 200 })),
    h('div.two',
      field('Courtroom', h('input', { name: 'courtroom', placeholder: 'Department 4', maxlength: 80 })),
      field('Presiding judge', h('input', { name: 'judge', placeholder: 'Hon. A. Judge', maxlength: 120 }))),
    field('Speakers (one per line, "LABEL | Role")', h('textarea', {
      name: 'speakers', rows: 5,
    }, 'THE COURT | Judge\nTHE CLERK | Clerk\nPROSECUTION | Prosecution\nDEFENSE | Defense\nTHE WITNESS | Witness')),
    h('div.row.end',
      h('button.ghost', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button.primary', { type: 'submit' }, 'Create hearing')),
  );
  const dialog = h('dialog', {}, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.speakers = data.speakers.split('\n').map((line) => {
      const [label, role] = line.split('|').map((x) => x?.trim());
      return label ? { label, role: role || 'Other' } : null;
    }).filter(Boolean);
    try {
      const s = await api('/sessions', { method: 'POST', body: data });
      dialog.close();
      location.hash = `#/session/${s.id}`;
    } catch (err) { toast(err.message, 'error'); }
  });
  return dialog;
}

function field(label, input) {
  return h('label.field', {}, h('span', {}, label), input);
}

function statusPill(status, recorderOnline) {
  const text = { idle: 'Not started', recording: recorderOnline === false ? 'Recording · recorder offline' : 'Recording', paused: 'Paused', closed: 'Closed' }[status] || status;
  return h(`span.pill.status-${status}`, {}, text);
}

// ============================================================================
// Hearing workspace
// ============================================================================
function SessionView(el, sessionId, params) {
  const clientId = tabClientId();
  const st = {
    session: null,
    speakers: new Map(),
    segments: new Map(),     // id -> segment
    local: new Map(),        // clientId -> optimistic segment awaiting ack
    sorted: [],
    els: new Map(),          // key -> <li>
    editing: new Map(),      // segment id -> { draft, conflict }
    hits: new Map(),         // segment id -> headline
    hitIds: [],
    hitIndex: -1,
    activeSpeaker: null,
    partials: new Map(),     // from -> { text, speakerId }
    audioSamples: 0,
    presence: { viewers: 0, recorder: false },
    recording: false,
    playingKey: null,
    follow: true,
    loadedAudioSamples: -1,
    transcriber: { state: 'unavailable', message: 'checking…' },
    engineChoice: null,
    retranscribing: false,
  };
  let alive = true;
  const pendingJump = params.get('seg');

  // ---- layout --------------------------------------------------------------
  const ui = {
    title: h('div.case-title'),
    status: h('span'),
    conn: h('button.pill.conn', { title: 'Connection status. Click to reconnect now.', onclick: () => socket.reconnectNow() }, 'Connecting…'),
    presence: h('span.muted.small'),
    meta: h('div.case-meta'),
    list: h('ol.transcript', { 'aria-label': 'Transcript', 'aria-live': 'polite' }),
    partials: h('div.partials', { 'aria-live': 'off' }),
    scroller: null,
    audio: h('audio', { controls: true, preload: 'metadata' }),
    audioNote: h('span.muted.small'),
    timer: h('div.timer.mono', {}, '00:00:00'),
    meter: h('div.meter', { 'aria-hidden': 'true' }, h('div.meter-fill')),
    recBtn: h('button.rec', { onclick: () => toggleRecording() }),
    endBtn: h('button.ghost', { onclick: () => endHearing() }, 'End hearing'),
    recNote: h('p.small.rec-note'),
    queue: h('p.small.mono.queue'),
    lang: h('select', { 'aria-label': 'Recognition language' },
      ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'es-ES', 'fr-FR', 'de-DE', 'hi-IN'].map((l) => h('option', { value: l }, l))),
    engine: h('select.engine', { 'aria-label': 'Transcription engine' }),
    engineNote: h('p.small.muted.engine-note'),
    retranscribe: h('button.ghost.small', { type: 'button', onclick: () => retranscribe() }, 'Re-transcribe with Whisper'),
    jobNote: h('p.small.job-note'),
    speakerList: h('ul.speakers'),
    manualSpeaker: h('select.manual-speaker', { 'aria-label': 'Speaker for typed line' }),
    manualInput: h('input', { placeholder: 'Type a line and press Enter (stenographer / correction entry)…', 'aria-label': 'Add a transcript line', maxlength: 10000 }),
    searchInput: h('input.search', { type: 'search', placeholder: 'Search this transcript', 'aria-label': 'Search this transcript' }),
    searchInfo: h('span.small.muted'),
    searchList: h('div.search-results'),
    followBox: h('input', { type: 'checkbox', checked: true }),
    diag: h('details.diag'),
    diagVerdict: h('p.diag-verdict'),
    diagCounts: h('p.small.mono.muted.diag-counts'),
    diagLog: h('ol.diag-log'),
    rate: h('select', { 'aria-label': 'Playback speed' }, ['0.75', '1', '1.25', '1.5', '2'].map((r) => h('option', { value: r, selected: r === '1' }, `${r}×`))),
  };
  ui.diag.append(
    h('summary', {}, 'Recognition diagnostics'),
    ui.diagVerdict,
    ui.diagCounts,
    h('p.small.muted', {}, `Browser: ${(navigator.userAgentData?.brands || []).map((b) => b.brand).filter((b) => !/Not.?A.?Brand/i.test(b)).join(', ') || navigator.userAgent}${navigator.brave ? ' (Brave)' : ''}`),
    ui.diagLog);
  try { ui.lang.value = localStorage.getItem('courtscribe.lang') || (navigator.language?.startsWith('en-') ? navigator.language : 'en-US'); } catch {}
  if (!ui.lang.value) ui.lang.value = 'en-US';
  ui.engine.addEventListener('change', () => {
    st.engineChoice = ui.engine.value;
    try { localStorage.setItem('courtscribe.engine', ui.engine.value); } catch {}
    renderEngine();
  });
  ui.lang.addEventListener('change', () => { try { localStorage.setItem('courtscribe.lang', ui.lang.value); } catch {} });

  const transcriptPane = h('section.transcript-pane',
    h('div.paper',
      h('div.paper-head', ui.meta),
      ui.list,
      ui.partials),
  );
  ui.scroller = transcriptPane;

  el.append(
    h('header.topbar',
      h('a.back', { href: '#/', onclick: (e) => { if (st.recording && !confirm('Recording is in progress. Leave and stop recording?')) e.preventDefault(); } }, '← Hearings'),
      ui.title,
      ui.status,
      h('div.spacer'),
      ui.presence,
      ui.conn,
      editorField(),
      h('a.button.ghost', { href: `/api/sessions/${sessionId}/export.txt` }, 'Export .txt')),
    h('div.workspace',
      h('div.main-col',
        transcriptPane,
        h('form.manual-entry', { onsubmit: (e) => { e.preventDefault(); addManualLine(); } },
          ui.manualSpeaker, ui.manualInput, h('button.primary', { type: 'submit' }, 'Add line'))),
      h('aside.side',
        h('section.card.recorder',
          h('h2', {}, 'Recorder'),
          h('div.rec-row', ui.recBtn, ui.timer, ui.endBtn),
          ui.meter,
          h('div.rec-opts',
            ui.engine,
            ui.lang),
          ui.engineNote,
          ui.recNote,
          ui.diag,
          h('div.row', ui.retranscribe),
          ui.jobNote,
          h('div.net',
            ui.queue,
            h('button.link.small', { type: 'button', title: 'Close the WebSocket to watch the client queue and reconnect', onclick: () => { socket.drop('simulated'); toast('Connection dropped. Watch it reconnect and resend queued data.'); } }, 'Simulate network drop'))),
        h('section.card',
          h('h2', {}, 'Speakers ', h('span.muted.small', {}, 'keys 1–9 switch')),
          ui.speakerList,
          h('form.add-speaker', { onsubmit: addSpeaker },
            h('input', { name: 'label', placeholder: 'Label, e.g. MR. SINGH', required: true, maxlength: 60, 'aria-label': 'New speaker label' }),
            h('input', { name: 'role', placeholder: 'Role', maxlength: 40, 'aria-label': 'New speaker role' }),
            h('button.ghost', { type: 'submit' }, 'Add'))),
        h('section.card.search-card',
          h('h2', {}, 'Search'),
          ui.searchInput,
          h('div.search-nav',
            ui.searchInfo,
            h('button.icon', { type: 'button', title: 'Previous match', onclick: () => stepHit(-1) }, '↑'),
            h('button.icon', { type: 'button', title: 'Next match', onclick: () => stepHit(1) }, '↓')),
          ui.searchList))),
    h('footer.player',
      ui.audio,
      h('label.check', {}, ui.followBox, ' Follow playback'),
      ui.rate,
      ui.audioNote),
  );

  // ---- realtime --------------------------------------------------------------
  const socket = new LiveSocket({ sessionId, clientId, name: editorName() });
  const recorder = new Recorder();

  socket.addEventListener('status', renderConn);
  socket.addEventListener('queue', renderQueue);
  socket.addEventListener('ready', async (e) => {
    const msg = e.detail;
    if (st.recording && msg.role !== 'recorder') {
      toast('Another device took over recording. Stopping here.', 'error');
      await stopRecording(false);
    }
    st.presence = { viewers: msg.viewers, recorder: msg.recorder };
    if (msg.transcriber) st.transcriber = msg.transcriber;
    if (msg.activeSpeaker !== undefined && !st.recording) st.pendingSpeaker = msg.activeSpeaker;
    renderEngine();
    renderPresence();
    // Resync after (re)joining the room: anything broadcast while we were away is picked up here.
    await loadAll(msg.reconnected);
    if (msg.reconnected) toast('Reconnected. Transcript resynced.', 'ok');
  });
  socket.addEventListener('message', (e) => onServer(e.detail));

  function onServer(msg) {
    switch (msg.type) {
      case 'segment.created':
      case 'segment.updated':
        upsertSegment(msg.segment);
        if (msg.type === 'segment.created' && msg.from) { st.partials.delete(msg.from); renderPartials(); }
        break;
      case 'segment.deleted':
        removeSegment(msg.segmentId);
        break;
      case 'speaker.upserted':
        st.speakers.set(msg.speaker.id, msg.speaker);
        renderSpeakers();
        rerenderAll();
        break;
      case 'speaker.deleted':
        st.speakers.delete(msg.speakerId);
        if (st.activeSpeaker === msg.speakerId) st.activeSpeaker = null;
        for (const s of st.segments.values()) if (s.speaker_id === msg.speakerId) s.speaker_id = null;
        renderSpeakers();
        rerenderAll();
        break;
      case 'speaker.active':
        // Someone on another screen switched speaker: it applies here too,
        // including to this tab's recording.
        applySpeaker(msg.speakerId);
        break;
      case 'partial':
        if (msg.text) st.partials.set(msg.from, { text: msg.text, speakerId: msg.speakerId });
        else st.partials.delete(msg.from);
        renderPartials();
        break;
      case 'session.updated':
        st.session = msg.session;
        if (msg.audioSamples != null) st.audioSamples = msg.audioSamples;
        renderHeader();
        if (msg.session.status !== 'recording') { st.partials.clear(); renderPartials(); refreshAudio(); }
        break;
      case 'session.deleted':
        toast('This hearing was deleted.', 'error');
        location.hash = '#/';
        break;
      case 'audio.progress':
        st.audioSamples = msg.samples;
        if (!st.recording) ui.timer.textContent = clock((msg.samples / TARGET_RATE) * 1000);
        break;
      case 'transcriber.status':
        onTranscriberStatus(msg);
        break;
      case 'transcript.reload':
        loadAll(true);
        break;
      case 'presence':
        st.presence = { viewers: msg.viewers, recorder: msg.recorder };
        renderPresence();
        renderHeader();
        break;
      case 'error':
        if (msg.code === 'recorder_busy') toast(msg.message, 'error');
        else if (msg.code !== 'not_recorder') console.warn('server:', msg);
        break;
    }
  }

  // ---- data loading -----------------------------------------------------------
  async function loadAll(isResync = false) {
    try {
      const data = await api(`/sessions/${sessionId}`);
      if (!alive) return;
      st.session = data.session;
      st.speakers = new Map(data.speakers.map((s) => [s.id, s]));
      st.segments = new Map(data.segments.map((s) => [s.id, s]));
      for (const [cid] of st.local) if (data.segments.some((s) => s.client_id === cid)) st.local.delete(cid);
      if (!st.recording) st.audioSamples = data.audioSamples;
      st.presence = data.presence;
      if (st.activeSpeaker == null || !st.speakers.has(st.activeSpeaker)) st.activeSpeaker = data.speakers[0]?.id ?? null;
      // Join with whoever the hearing's current speaker is (set on any screen).
      if (st.pendingSpeaker !== undefined) {
        if (st.pendingSpeaker === null || st.speakers.has(st.pendingSpeaker)) st.activeSpeaker = st.pendingSpeaker;
        st.pendingSpeaker = undefined;
      }
      renderHeader();
      renderSpeakers();
      rerenderAll();
      renderRecorder();
      if (!st.recording) ui.timer.textContent = clock((st.audioSamples / TARGET_RATE) * 1000);
      refreshAudio();
      if (!isResync && pendingJump) setTimeout(() => jumpTo(Number(pendingJump), true), 50);
      if (ui.searchInput.value.trim()) runSearch();
    } catch (err) {
      if (err.status === 404) {
        el.replaceChildren(h('main.home', h('div.empty', h('h2', {}, 'Hearing not found'), h('a', { href: '#/' }, 'Back to hearings'))));
        return;
      }
      toast(`Could not load hearing: ${err.message}`, 'error');
    }
  }

  // ---- transcript rendering ------------------------------------------------------
  const keyOf = (s) => (s.local ? `l:${s.client_id}` : `s:${s.id}`);
  const speakerOf = (id) => st.speakers.get(id);

  function allSegments() {
    const list = [...st.segments.values(), ...st.local.values()];
    list.sort((a, b) => a.start_ms - b.start_ms || (a.local ? 1 : 0) - (b.local ? 1 : 0) || a.id - b.id);
    return list;
  }

  function upsertSegment(seg) {
    if (seg.client_id && st.local.has(seg.client_id)) {
      st.els.get(`l:${seg.client_id}`)?.remove();
      st.els.delete(`l:${seg.client_id}`);
      st.local.delete(seg.client_id);
    }
    const prev = st.segments.get(seg.id);
    if (prev && prev.version > seg.version) return; // stale event
    st.segments.set(seg.id, seg);
    const editing = st.editing.get(seg.id);
    if (editing && prev && prev.version !== seg.version) {
      editing.remote = seg;
      showRemoteChange(seg.id);
      return;
    }
    const nearBottom = isNearBottom();
    placeAll();
    if (st.recording && nearBottom && !prev) scrollToBottom();
  }

  function removeSegment(id) {
    st.segments.delete(id);
    st.editing.delete(id);
    st.hits.delete(id);
    st.els.get(`s:${id}`)?.remove();
    st.els.delete(`s:${id}`);
    placeAll(false);
  }

  function rerenderAll() {
    for (const [key, li] of st.els) {
      const id = Number(key.slice(2));
      if (key.startsWith('s:') && st.editing.has(id)) continue;
      li.remove();
      st.els.delete(key);
    }
    placeAll();
  }

  /** Put every segment's element in time order, building the ones that are missing or stale. */
  function placeAll(rebuild = true) {
    st.sorted = allSegments();
    const live = new Set();
    let prevEl = null;
    for (const seg of st.sorted) {
      const key = keyOf(seg);
      live.add(key);
      let li = st.els.get(key);
      const stale = li && rebuild && !st.editing.has(seg.id) && li.dataset.v !== stamp(seg);
      if (!li || stale) {
        const fresh = segmentEl(seg);
        if (li) li.replaceWith(fresh);
        li = fresh;
        st.els.set(key, li);
      }
      const want = prevEl ? prevEl.nextSibling : ui.list.firstChild;
      if (want !== li) ui.list.insertBefore(li, want);
      prevEl = li;
    }
    for (const [key, li] of st.els) if (!live.has(key)) { li.remove(); st.els.delete(key); }
    if (!st.sorted.length) {
      ui.list.replaceChildren(h('li.empty-line', {}, st.recording ? 'Listening… lines appear here as they are recognised.' : 'No transcript yet. Press Record to begin, or type a line below.'));
    } else {
      ui.list.querySelector('.empty-line')?.remove();
    }
    st.playingKey = null;
    syncPlayhead();
  }

  const stamp = (seg) => [seg.version, seg.speaker_id, seg.start_ms, st.hits.get(seg.id) || '', speakerOf(seg.speaker_id)?.label, speakerOf(seg.speaker_id)?.color].join('|');

  function segmentEl(seg) {
    const sp = speakerOf(seg.speaker_id);
    const hit = st.hits.get(seg.id);
    const text = h('span.text');
    if (hit) text.innerHTML = headlineHtml(hit); else text.textContent = seg.text;
    const lowConf = seg.confidence != null && seg.confidence > 0 && seg.confidence < 0.6;
    if (lowConf) { text.classList.add('low-conf'); text.title = `Recogniser confidence ${(seg.confidence * 100).toFixed(0)}%. Check against the audio.`; }

    const li = h(`li.seg${seg.local ? '.pending' : ''}${hit ? '.hit' : ''}`, {
      dataset: { key: keyOf(seg), v: stamp(seg) },
      style: { '--spk': sp?.color || '#6b7280' },
    },
      h('button.ts.mono', {
        type: 'button',
        title: `Play from ${clock(seg.start_ms)}${st.session?.started_at ? ` (${wallClock(st.session.started_at, seg.start_ms)})` : ''}`,
        onclick: () => seek(seg.start_ms, true),
      }, clock(seg.start_ms)),
      h('div.seg-body',
        h('button.spk', { type: 'button', title: 'Change speaker', disabled: seg.local, onclick: (e) => speakerMenu(e.currentTarget, seg) }, `${sp?.label || 'UNIDENTIFIED'}:`),
        ' ',
        text,
        h('span.seg-meta',
          seg.local ? h('span.tag.queued', {}, 'sending…') : null,
          seg.source === 'manual' ? h('span.tag', { title: 'Typed entry' }, 'typed') : null,
          seg.revision_count ? h('button.tag.link', { type: 'button', title: 'View edit history', onclick: () => showHistory(seg) }, `edited ×${seg.revision_count}`) : null)),
      seg.local ? null : h('div.seg-actions',
        h('button.icon', { type: 'button', title: 'Edit text (or double-click the line)', onclick: () => beginEdit(seg.id) }, '✎'),
        h('button.icon', { type: 'button', title: 'Set this line to start at the current playback position', onclick: () => syncToPlayhead(seg.id) }, '⇤'),
        h('button.icon', { type: 'button', title: 'Edit history', onclick: () => showHistory(seg) }, '⟲'),
        h('button.icon.danger', { type: 'button', title: 'Delete line', onclick: () => deleteLine(seg.id) }, '✕')),
    );
    if (!seg.local) text.addEventListener('dblclick', () => beginEdit(seg.id));
    return li;
  }

  function renderPartials() {
    ui.partials.replaceChildren(...[...st.partials.values()].map((p) => {
      const sp = speakerOf(p.speakerId);
      return h('div.partial', { style: { '--spk': sp?.color || '#6b7280' } },
        h('span.spk', {}, `${sp?.label || 'UNIDENTIFIED'}:`), ' ', h('span', {}, p.text), h('span.caret', { 'aria-hidden': 'true' }));
    }));
    if (st.recording && isNearBottom(240)) scrollToBottom();
  }

  const isNearBottom = (px = 160) => ui.scroller.scrollHeight - ui.scroller.scrollTop - ui.scroller.clientHeight < px;
  const scrollToBottom = () => { ui.scroller.scrollTop = ui.scroller.scrollHeight; };

  // ---- editing --------------------------------------------------------------------
  function beginEdit(id, draft, note) {
    const seg = st.segments.get(id);
    const li = st.els.get(`s:${id}`);
    if (!seg || !li) return;
    // Pin the version this edit is based on; live updates must not move it,
    // or a save would silently overwrite someone else's change.
    const baseVersion = seg.version;
    st.editing.set(id, { draft: draft ?? seg.text, baseVersion });
    const area = h('textarea', { rows: Math.min(8, Math.max(2, Math.ceil(seg.text.length / 70))), 'aria-label': 'Edit line' }, draft ?? seg.text);
    const box = h('div.editor',
      note ? h('p.conflict', {}, note) : null,
      area,
      h('div.row',
        h('span.small.muted', {}, 'Enter to save · Shift+Enter for a new line · Esc to cancel'),
        h('div.spacer'),
        h('button.ghost', { type: 'button', onclick: cancel }, 'Cancel'),
        h('button.primary', { type: 'button', onclick: save }, 'Save')));
    li.querySelector('.text').replaceWith(box);
    li.classList.add('editing');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    });

    function cancel() {
      st.editing.delete(id);
      st.els.get(`s:${id}`)?.remove();
      st.els.delete(`s:${id}`);
      placeAll();
    }
    async function save() {
      const text = area.value.trim();
      const cur = st.segments.get(id);
      if (!text) { if (confirm('The line is empty. Delete it instead?')) { st.editing.delete(id); deleteLine(id, true); } return; }
      if (text === cur.text && cur.version === baseVersion) return cancel();
      try {
        const updated = await api(`/segments/${id}`, { method: 'PATCH', body: { text, version: baseVersion } });
        st.editing.delete(id);
        st.segments.set(id, updated);
        cancel();
      } catch (err) {
        if (err.status === 409 && err.data?.segment) {
          st.segments.set(id, err.data.segment);
          st.editing.delete(id);
          st.els.get(`s:${id}`)?.remove();
          st.els.delete(`s:${id}`);
          placeAll();
          beginEdit(id, text, `Someone saved this line while you were editing. Their version: “${err.data.segment.text}”. Save again to replace it with yours.`);
        } else toast(err.message, 'error');
      }
    }
  }

  function showRemoteChange(id) {
    const li = st.els.get(`s:${id}`);
    const editing = st.editing.get(id);
    if (!li || !editing?.remote || li.querySelector('.conflict')) return;
    li.querySelector('.editor')?.prepend(h('p.conflict', {}, `Updated by someone else just now: “${editing.remote.text}”. Saving will ask you to confirm.`));
  }

  async function patchSegment(id, body) {
    const cur = st.segments.get(id);
    try {
      const updated = await api(`/segments/${id}`, { method: 'PATCH', body: { ...body, version: cur.version } });
      upsertSegment(updated);
    } catch (err) {
      if (err.status === 409 && err.data?.segment) { upsertSegment(err.data.segment); toast('That line had just changed. Showing the latest version; try again.', 'error'); }
      else toast(err.message, 'error');
    }
  }

  function syncToPlayhead(id) {
    if (!ui.audio.src || Number.isNaN(ui.audio.duration)) return toast('Load the recording first: play to the right moment, then use ⇤.', 'error');
    const start = Math.round(ui.audio.currentTime * 1000);
    const cur = st.segments.get(id);
    patchSegment(id, { start_ms: start, end_ms: Math.max(start, start + (cur.end_ms - cur.start_ms)) });
  }

  async function deleteLine(id, skipConfirm) {
    const seg = st.segments.get(id);
    if (!seg) return;
    if (!skipConfirm && !confirm(`Delete this line?\n\n“${seg.text.slice(0, 200)}”`)) return;
    try {
      await api(`/segments/${id}`, { method: 'DELETE' });
      removeSegment(id);
    } catch (err) { toast(err.message, 'error'); }
  }

  function speakerMenu(anchor, seg) {
    closeMenus();
    const menu = h('div.menu', { role: 'menu' },
      [...st.speakers.values()].map((sp) => h('button', {
        type: 'button', role: 'menuitem', style: { '--spk': sp.color },
        class: sp.id === seg.speaker_id ? 'current' : null,
        onclick: () => { closeMenus(); if (sp.id !== seg.speaker_id) patchSegment(seg.id, { speaker_id: sp.id }); },
      }, h('i.dot'), sp.label, h('span.muted.small', {}, sp.role))),
      h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenus(); patchSegment(seg.id, { speaker_id: null }); } }, h('i.dot'), 'UNIDENTIFIED'));
    const r = anchor.getBoundingClientRect();
    Object.assign(menu.style, { left: `${Math.min(r.left, window.innerWidth - 240)}px`, top: `${r.bottom + 4}px` });
    document.body.append(menu);
    menu.querySelector('button')?.focus();
    setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
  }
  const closeMenus = () => document.querySelectorAll('.menu').forEach((m) => m.remove());

  async function showHistory(seg) {
    const revs = await api(`/segments/${seg.id}/revisions`).catch((e) => { toast(e.message, 'error'); return null; });
    if (!revs) return;
    const cur = st.segments.get(seg.id) || seg;
    const dlg = h('dialog.history',
      h('h2', {}, `Line history · ${clock(cur.start_ms)}`),
      h('ol.revs',
        h('li.current', h('div.rev-head', h('b', {}, `v${cur.version} (current)`), h('span.muted.small', {}, new Date(cur.updated_at).toLocaleString())),
          h('div', {}, h('b', {}, `${speakerOf(cur.speaker_id)?.label || 'UNIDENTIFIED'}: `), cur.text)),
        revs.map((r) => h('li', h('div.rev-head', h('b', {}, `v${r.version}`),
          h('span.muted.small', {}, `replaced ${new Date(r.replaced_at).toLocaleString()}${r.edited_by ? ` by ${r.edited_by}` : ''} · at ${clock(r.start_ms)}`)),
        h('div', {}, h('b', {}, `${r.speaker_label || 'UNIDENTIFIED'}: `), r.text))),
        revs.length ? null : h('li.muted', {}, 'No edits. This is the text as originally captured.')),
      h('div.row.end', h('button.primary', { type: 'button', onclick: () => dlg.close() }, 'Close')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---- speakers ---------------------------------------------------------------------
  function renderSpeakers() {
    const speakers = [...st.speakers.values()];
    ui.speakerList.replaceChildren(...speakers.map((sp, i) => {
      const color = h('input', {
        type: 'color', value: sp.color, title: 'Speaker colour', 'aria-label': `Colour for ${sp.label}`,
        onchange: (e) => api(`/speakers/${sp.id}`, { method: 'PATCH', body: { color: e.target.value } }).catch((err) => toast(err.message, 'error')),
      });
      return h(`li${sp.id === st.activeSpeaker ? '.active' : ''}`, {
        style: { '--spk': sp.color },
      },
        h('kbd', {}, i < 9 ? String(i + 1) : ''),
        h('label.swatch', {}, color),
        h('button.sp-main', { type: 'button', title: 'Set as the current speaker', onclick: () => setActive(sp.id) },
          h('span.sp-label', {}, sp.label), h('span.sp-role', {}, sp.role)),
        h('button.icon', { type: 'button', title: 'Rename', onclick: () => renameSpeaker(sp) }, '✎'),
        h('button.icon.danger', { type: 'button', title: 'Remove speaker', onclick: () => removeSpeaker(sp) }, '✕'));
    }));
    ui.manualSpeaker.replaceChildren(
      ...speakers.map((sp) => h('option', { value: sp.id, selected: sp.id === st.activeSpeaker }, sp.label)),
      h('option', { value: '', selected: st.activeSpeaker == null }, 'UNIDENTIFIED'));
  }

  /** The active speaker is shared by every screen on this hearing. */
  function setActive(id) {
    if (id === st.activeSpeaker) return;
    applySpeaker(id);
    sendSpeakerChange(id);
  }

  function applySpeaker(id) {
    if (id != null && !st.speakers.has(id)) return;
    st.activeSpeaker = id;
    recorder.setSpeaker(id);
    renderSpeakers();
  }

  async function addSpeaker(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const sp = await api(`/sessions/${sessionId}/speakers`, { method: 'POST', body: data });
      st.speakers.set(sp.id, sp);
      renderSpeakers();
      form.reset();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function renameSpeaker(sp) {
    const label = prompt('Speaker label as it should appear in the transcript', sp.label);
    if (label == null) return;
    const role = prompt('Role (Judge, Prosecution, Defense, Witness, Clerk, Interpreter…)', sp.role);
    if (role == null) return;
    try {
      const updated = await api(`/speakers/${sp.id}`, { method: 'PATCH', body: { label, role } });
      st.speakers.set(updated.id, updated);
      renderSpeakers();
      rerenderAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function removeSpeaker(sp) {
    if (!confirm(`Remove ${sp.label}? Their lines stay in the transcript as UNIDENTIFIED.`)) return;
    await api(`/speakers/${sp.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
  }

  // ---- recording ---------------------------------------------------------------------
  recorder.addEventListener('audio', (e) => {
    socket.sendAudio(e.detail.offset, e.detail.pcm);
    st.audioSamples = recorder.samples;
    ui.timer.textContent = clock(recorder.currentMs);
  });
  recorder.addEventListener('level', (e) => {
    const pct = Math.min(100, Math.round(Math.sqrt(e.detail.rms) * 180));
    ui.meter.firstChild.style.width = `${pct}%`;
  });
  recorder.addEventListener('partial', (e) => {
    const { text, speakerId, startMs } = e.detail;
    socket.sendVolatile({ type: 'partial', text, speakerId, startMs });
    if (text) st.partials.set(clientId, { text, speakerId }); else st.partials.delete(clientId);
    renderPartials();
  });
  recorder.addEventListener('final', (e) => {
    st.partials.delete(clientId);
    renderPartials();
    sendLine({ ...e.detail, source: 'speech' });
  });
  recorder.addEventListener('recognition-error', (e) => {
    const messages = {
      'not-allowed': 'Speech recognition permission was denied. Audio is still recording; type lines manually.',
      'service-not-allowed': 'This browser blocks its speech service here. Audio is still recording; type lines manually.',
      network: 'Speech service unreachable (offline?). Audio keeps recording and recognition retries automatically.',
      'audio-capture': 'No microphone available for speech recognition.',
      'language-not-supported': `Language ${ui.lang.value} is not supported by this browser.`,
    };
    lastRecError = { text: messages[e.detail.error] || `Speech recognition error: ${e.detail.error}`, at: Date.now() };
    ui.recNote.textContent = lastRecError.text;
    ui.recNote.className = 'small rec-note warn';
  });
  // Diagnostics: a log of what the recogniser reports, kept after pausing,
  // plus a plain-language verdict on where the pipeline stops.
  const diag = { log: [], counts: {} };
  function resetDiag() {
    diag.log = [];
    diag.counts = {};
    renderDiag();
  }
  recorder.addEventListener('recognition-trace', (e) => {
    const { event, atMs } = e.detail;
    const key = event.split(':')[0];
    diag.counts[key] = (diag.counts[key] || 0) + 1;
    if (key === 'error') (diag.counts.errorList ||= new Set()).add(event.slice(7).split(' ')[0]);
    // Results arrive many times a second; log only the first of each run.
    const last = diag.log[diag.log.length - 1];
    if (!(event === 'result' && last?.event === 'result')) diag.log.push({ event, atMs });
    if (diag.log.length > 200) diag.log.shift();
    renderDiag();
  });

  function diagVerdict() {
    const c = diag.counts;
    const errs = c.errorList || new Set();
    if (!speechSupported) return ['bad', 'This browser has no speech recognition. Use Chrome or Edge.'];
    if (navigator.brave) return ['bad', 'Brave disables the speech service Chrome uses, so nothing is transcribed. Use Chrome or Edge.'];
    if (!c.start && !c['start failed']) return ['muted', 'Recognition has not run yet. Press Record with Live transcription ticked.'];
    if (errs.has('not-allowed') || errs.has('service-not-allowed')) return ['bad', 'The browser refused speech recognition on this page (permission or policy). Check the microphone permission for this site.'];
    if (errs.has('network')) return ['bad', 'The browser could not reach its speech service (network error). Check the internet connection, VPN or firewall. Brave and some Chromium browsers always fail here.'];
    if (errs.has('language-not-supported')) return ['bad', `Language ${ui.lang.value} is not supported. Pick another.`];
    if (errs.has('audio-capture')) return ['bad', 'The recogniser could not open a microphone.'];
    if (c.result) return ['ok', `Working: ${c.result} result event${c.result === 1 ? '' : 's'} received.`];
    if (!c.audiostart) return ['bad', 'Recognition started but never received microphone audio. Another app may hold the microphone, or the browser is using a different input device.'];
    if (!c.soundstart) return ['bad', 'The recogniser hears only silence, although the recording has sound. Usually: the sound comes from this computer\'s speakers (the browser\'s echo cancellation removes it), or Windows/Chrome uses a different microphone. Speak directly into the mic, or check the default input device.'];
    if (!c.speechstart) return ['warn', 'The recogniser hears sound but does not detect speech in it. Speak closer to the microphone, or check the input level.'];
    return ['warn', `Speech detected but no text returned. Try another language setting (you have ${ui.lang.value}; en-IN may suit an Indian accent better), or the speech service may be failing.`];
  }

  function renderDiag() {
    const [kind, text] = diagVerdict();
    const c = diag.counts;
    ui.diagVerdict.textContent = text;
    ui.diagVerdict.className = `diag-verdict ${kind}`;
    ui.diagCounts.textContent = ['start', 'audiostart', 'soundstart', 'speechstart', 'result', 'end']
      .map((k) => `${k} ${c[k] || 0}`).join(' · ') + (c.errorList?.size ? ` · errors: ${[...c.errorList].join(', ')}` : '');
    ui.diagLog.replaceChildren(...diag.log.slice(-40).reverse().map((l) => h('li', {}, h('span.mono', {}, clock(l.atMs)), ` ${l.event}`)));
    ui.diag.classList.toggle('flag', kind === 'bad' || kind === 'warn');
    if (kind === 'bad' || kind === 'warn') ui.diag.open = true;
  }

  // Show whether recognition is actually running, so a stalled recogniser is
  // visible instead of silently producing nothing.
  let lastRecError = null;
  recorder.addEventListener('recognition-state', (e) => {
    if (!st.recording) return;
    const recent = lastRecError && Date.now() - lastRecError.at < 30_000 ? lastRecError.text : null;
    if (e.detail.state === 'listening') {
      ui.recNote.textContent = recent || `Speech recognition listening${e.detail.restarts ? ` (restarted ${e.detail.restarts}×)` : ''}. Keys 1–9 switch speaker.`;
    } else {
      ui.recNote.textContent = recent || 'Speech recognition restarting…';
    }
    ui.recNote.className = `small rec-note${recent ? ' warn' : ''}`;
  });

  /** Optimistically show a line, then deliver it reliably over the socket. */
  function sendLine({ text, startMs, endMs, speakerId, confidence = null, source }) {
    const msg = { type: 'segment', clientId: crypto.randomUUID(), text, startMs, endMs, speakerId, confidence, source };
    st.local.set(msg.clientId, {
      local: true, id: 0, client_id: msg.clientId, text, start_ms: startMs, end_ms: endMs,
      speaker_id: speakerId, confidence, source, version: 0, revision_count: 0,
    });
    const nearBottom = isNearBottom();
    placeAll();
    if (nearBottom) scrollToBottom();
    socket.sendReliable(msg)
      .then((ack) => upsertSegment(ack.segment))
      .catch((err) => {
        st.local.delete(msg.clientId);
        placeAll();
        toast(`Line not saved: ${err.message}`, 'error');
      });
  }

  function addManualLine() {
    const text = ui.manualInput.value.trim();
    if (!text) return;
    const speakerId = ui.manualSpeaker.value ? Number(ui.manualSpeaker.value) : null;
    let at;
    if (st.recording) at = recorder.currentMs;
    else if (ui.audio.src && ui.audio.currentTime > 0) at = Math.round(ui.audio.currentTime * 1000);
    else at = st.sorted.length ? st.sorted[st.sorted.length - 1].end_ms : 0;
    sendLine({ text, startMs: at, endMs: at, speakerId, source: 'manual' });
    ui.manualInput.value = '';
  }

  async function toggleRecording() {
    if (st.recording) return stopRecording(false);
    if (st.session?.status === 'closed' && !confirm('This hearing was closed. Reopen it and continue recording?')) return;
    if (!navigator.mediaDevices?.getUserMedia) return toast('This browser cannot access a microphone (needs https or localhost).', 'error');
    ui.recBtn.disabled = true;
    try {
      socket.role = 'recorder';
      resetDiag();
      // Start capturing immediately, appending after the audio already stored.
      // The start request is delivered reliably, so recording works even if
      // the connection is down right now.
      await recorder.start({
        startSample: st.audioSamples,
        lang: ui.lang.value,
        speakerId: st.activeSpeaker,
        transcribe: ui.engine.value === 'browser',
      });
      st.recording = true;
      const engineName = ui.engine.value;
      ui.recNote.textContent = {
        whisper: 'Recording. Whisper writes each sentence a moment after it ends. Switch speakers with keys 1–9.',
        browser: 'Listening. Switch speakers with keys 1–9 as people talk.',
        off: 'Recording audio only. Type lines below as they are spoken.',
      }[engineName];
      ui.recNote.className = 'small rec-note';
      socket.sendReliable({ type: 'record.start', engine: engineName, language: ui.lang.value, speakerId: st.activeSpeaker })
        .then((ack) => {
          if (engineName === 'whisper' && ack.transcription !== 'whisper') {
            toast('Whisper is not available on the server, so this recording is audio only.', 'error');
          }
        })
        .catch(async (err) => {
          toast(err.message, 'error');
          await stopRecording(false, true);
        });
      sendSpeakerChange(st.activeSpeaker);
      placeAll();
    } catch (err) {
      socket.role = 'viewer';
      toast(err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Could not start recording: ${err.message}`, 'error');
    } finally {
      ui.recBtn.disabled = false;
      renderRecorder();
    }
  }

  async function stopRecording(close, rejected = false) {
    if (!st.recording) return;
    st.recording = false;
    await recorder.stop();
    st.audioSamples = recorder.samples;
    ui.meter.firstChild.style.width = '0%';
    st.partials.delete(clientId);
    renderPartials();
    renderRecorder();
    placeAll(); // refresh the empty-transcript message, which says "Listening…" while recording
    if (rejected) {
      socket.audioQueue = [];
      socket.role = 'viewer';
    } else {
      socket.sendReliable({ type: 'record.stop', close })
        .then(() => waitForAudioFlush())
        .then(() => { if (!st.recording) socket.role = 'viewer'; refreshAudio(); })
        .catch((err) => toast(err.message, 'error'));
    }
    ui.recNote.textContent = close ? 'Hearing closed.' : 'Paused. Press Record to continue on the same recording.';
    ui.recNote.className = 'small rec-note';
  }

  async function waitForAudioFlush() {
    for (let i = 0; i < 100 && socket.audioQueue.length; i++) await new Promise((r) => setTimeout(r, 100));
  }

  async function endHearing() {
    if (!confirm('End the hearing? Recording stops and the hearing is marked closed. You can still edit and reopen it.')) return;
    if (st.recording) await stopRecording(true);
    else {
      try { st.session = await api(`/sessions/${sessionId}`, { method: 'PATCH', body: { status: 'closed' } }); renderHeader(); }
      catch (err) { toast(err.message, 'error'); }
    }
  }

  /** Speaker changes carry the audio time they happened at, so Whisper lines split at exactly that word. */
  function sendSpeakerChange(id) {
    // Only the recording tab knows the exact audio time; others let the server stamp it.
    const msg = { type: 'speaker.active', speakerId: id };
    if (st.recording) msg.atMs = recorder.currentMs;
    socket.sendReliable(msg).catch(() => {});
  }

  function renderEngine() {
    const t = st.transcriber;
    const whisperReady = t.state === 'ready';
    const options = [
      ['whisper', whisperReady ? 'Whisper (accurate)' : 'Whisper (' + t.state + ')', !whisperReady],
      ['browser', speechSupported ? 'Browser speech (fast)' : 'Browser speech (unsupported)', !speechSupported],
      ['off', 'No transcription', false],
    ];
    let choice = st.engineChoice;
    if (!choice) { try { choice = localStorage.getItem('courtscribe.engine'); } catch {} }
    if (!choice || options.find((o) => o[0] === choice)?.[2]) choice = whisperReady ? 'whisper' : speechSupported ? 'browser' : 'off';
    ui.engine.replaceChildren(...options.map(([value, label, disabled]) => h('option', { value, disabled, selected: value === choice }, label)));
    ui.engine.value = choice;
    ui.engine.disabled = st.recording;
    ui.engineNote.textContent = whisperReady
      ? 'Whisper: ' + t.message + '. Runs on this computer; audio never leaves it.'
      : 'Whisper: ' + t.message;
    ui.engineNote.className = 'small engine-note ' + (t.state === 'error' ? 'warn' : 'muted');
    ui.diag.hidden = choice !== 'browser';
    ui.retranscribe.disabled = !whisperReady || st.recording || !st.audioSamples || st.retranscribing;
    ui.retranscribe.title = whisperReady ? 'Run the whole recording through Whisper again. Typed lines are kept.' : 'Whisper is not available';
  }

  async function retranscribe() {
    if (!confirm('Re-transcribe the whole recording with Whisper?\n\nAutomatically recognised lines are replaced (edits to them are lost). Typed lines are kept. Speakers carry over from the old lines where they overlap.')) return;
    try {
      st.retranscribing = true;
      renderEngine();
      await api('/sessions/' + sessionId + '/retranscribe', { method: 'POST', body: { language: ui.lang.value } });
      ui.jobNote.textContent = 'Re-transcribing…';
      ui.jobNote.className = 'small job-note';
    } catch (err) {
      st.retranscribing = false;
      renderEngine();
      toast(err.message, 'error');
    }
  }

  function onTranscriberStatus(msg) {
    if (msg.state === 'engine') {
      st.transcriber = msg.engine;
    } else if (msg.state === 'retranscribing') {
      st.retranscribing = true;
      ui.jobNote.textContent = msg.doneMs != null
        ? 'Re-transcribing… ' + clock(msg.doneMs) + ' of ' + clock(msg.totalMs)
        : 'Re-transcribing ' + clock(msg.totalMs) + ' of audio…';
      ui.jobNote.className = 'small job-note';
    } else if (msg.state === 'done') {
      st.retranscribing = false;
      ui.jobNote.textContent = '';
      toast('Whisper finished: ' + msg.lines + ' line' + (msg.lines === 1 ? '' : 's') + '.', 'ok');
    } else if (msg.state === 'error') {
      st.retranscribing = false;
      ui.jobNote.textContent = 'Transcription error: ' + msg.message;
      ui.jobNote.className = 'small job-note warn';
    }
    renderEngine();
  }

  function renderRecorder() {
    ui.recBtn.className = `rec${st.recording ? ' on' : ''}`;
    ui.recBtn.replaceChildren(h('span.rec-dot', { 'aria-hidden': 'true' }), st.recording ? 'Pause' : (st.audioSamples ? 'Resume' : 'Record'));
    ui.recBtn.setAttribute('aria-pressed', String(st.recording));
    ui.lang.disabled = st.recording;
    renderEngine();
    document.body.classList.toggle('is-recording', st.recording);
  }

  function renderQueue() {
    const ms = socket.queuedAudioMs;
    const n = socket.pendingCount;
    const parts = [];
    if (ms > 600) parts.push(`${(ms / 1000).toFixed(1)} s audio`);
    if (n) parts.push(`${n} message${n === 1 ? '' : 's'}`);
    ui.queue.textContent = parts.length ? `Queued for delivery: ${parts.join(', ')}` : (socket.state === 'open' ? 'All data delivered.' : '');
    ui.queue.classList.toggle('warn', parts.length > 0 && socket.state !== 'open');
  }

  // ---- header / status ---------------------------------------------------------------------
  function renderHeader() {
    const s = st.session;
    if (!s) return;
    document.title = `${s.case_number} · CourtScribe`;
    ui.title.replaceChildren(h('span.mono', {}, s.case_number), h('span.sep', {}, '·'), h('span', {}, s.title));
    ui.status.replaceChildren(statusPill(s.status, s.status === 'recording' ? (st.recording || st.presence.recorder) : undefined));
    ui.meta.replaceChildren(
      h('div.court-line', {}, 'Transcript of proceedings'),
      h('h1', {}, s.title),
      h('dl',
        h('dt', {}, 'Case'), h('dd.mono', {}, s.case_number),
        s.courtroom ? [h('dt', {}, 'Courtroom'), h('dd', {}, s.courtroom)] : null,
        s.judge ? [h('dt', {}, 'Presiding'), h('dd', {}, s.judge)] : null,
        s.started_at ? [h('dt', {}, 'Commenced'), h('dd', {}, new Date(s.started_at).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }))] : null));
  }

  function renderPresence() {
    const { viewers, recorder: rec } = st.presence;
    ui.presence.textContent = `${viewers || 1} connected${rec && !st.recording ? ' · recording elsewhere' : ''}`;
  }

  let connTick;
  function renderConn() {
    clearInterval(connTick);
    const paint = () => {
      const { state, retryAt } = socket;
      const map = {
        open: ['Live', 'ok'],
        connecting: ['Connecting…', 'wait'],
        reconnecting: [`Reconnecting${retryAt > Date.now() ? ` in ${Math.ceil((retryAt - Date.now()) / 1000)}s` : '…'}`, 'wait'],
        offline: ['Offline', 'bad'],
        idle: ['…', 'wait'],
      };
      const [text, kind] = map[state] || map.idle;
      ui.conn.textContent = text;
      ui.conn.className = `pill conn ${kind}`;
      renderQueue();
    };
    paint();
    if (socket.state === 'reconnecting') connTick = setInterval(paint, 500);
  }

  // ---- playback sync ------------------------------------------------------------------------
  function refreshAudio() {
    const samples = st.recording ? 0 : st.audioSamples;
    if (!samples) {
      ui.audioNote.textContent = st.recording ? 'Playback available after pausing.' : 'No audio recorded yet.';
      return;
    }
    if (samples === st.loadedAudioSamples) return;
    if (!ui.audio.paused) {
      ui.audioNote.textContent = 'Newer audio available; it loads when playback pauses.';
      ui.audio.addEventListener('pause', refreshAudio, { once: true });
      return;
    }
    const t = ui.audio.currentTime || 0;
    st.loadedAudioSamples = samples;
    ui.audio.src = `/api/sessions/${sessionId}/audio?v=${samples}`;
    ui.audio.addEventListener('loadedmetadata', () => { if (t) ui.audio.currentTime = Math.min(t, ui.audio.duration || t); }, { once: true });
    ui.audioNote.textContent = `${clock((samples / TARGET_RATE) * 1000)} recorded · click any timestamp to play from there`;
  }

  function seek(ms, play) {
    if (!ui.audio.src) return toast('No audio to play yet.', 'error');
    const go = () => {
      ui.audio.currentTime = ms / 1000;
      if (play) ui.audio.play().catch(() => {});
    };
    if (ui.audio.readyState >= 1) go(); else ui.audio.addEventListener('loadedmetadata', go, { once: true });
  }

  /** Highlight the line under the playhead (binary search over time-sorted lines). */
  function syncPlayhead() {
    if (!ui.audio.src || ui.audio.readyState < 1) return;
    const t = ui.audio.currentTime * 1000;
    const list = st.sorted;
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start_ms <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const seg = idx >= 0 ? list[idx] : null;
    const next = idx + 1 < list.length ? list[idx + 1] : null;
    const within = seg && (t <= seg.end_ms + 400 || (next && t < next.start_ms && t - seg.end_ms < 1500));
    const key = within ? keyOf(seg) : null;
    if (key === st.playingKey) return;
    if (st.playingKey) st.els.get(st.playingKey)?.classList.remove('playing');
    st.playingKey = key;
    const li = key && st.els.get(key);
    if (li) {
      li.classList.add('playing');
      if (st.follow && !ui.audio.paused && !st.editing.size) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  ui.audio.addEventListener('timeupdate', syncPlayhead);
  ui.audio.addEventListener('seeked', syncPlayhead);
  ui.followBox.addEventListener('change', () => { st.follow = ui.followBox.checked; });
  ui.rate.addEventListener('change', () => { ui.audio.playbackRate = Number(ui.rate.value); });

  // ---- search ---------------------------------------------------------------------------
  const runSearch = debounce(async () => {
    const q = ui.searchInput.value.trim();
    if (!q) return clearSearch();
    try {
      const hits = await api(`/search?q=${encodeURIComponent(q)}&session_id=${sessionId}`);
      if (!alive || ui.searchInput.value.trim() !== q) return;
      st.hits = new Map(hits.map((r) => [r.id, r.headline]));
      st.hitIds = hits.map((r) => r.id);
      st.hitIndex = -1;
      ui.searchInfo.textContent = hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : 'No matches';
      ui.searchList.replaceChildren(...hits.map((r, i) => h('button.hit', { type: 'button', onclick: () => { st.hitIndex = i; jumpTo(r.id, true); } },
        h('span.mono.small', {}, clock(r.start_ms)),
        h('span.hit-text', {}, h('b', { style: { color: r.speaker_color || 'inherit' } }, `${r.speaker_label || 'UNIDENTIFIED'}: `), h('span', { html: headlineHtml(r.headline) })))));
      placeAll();
    } catch (err) { toast(err.message, 'error'); }
  }, 220);

  function clearSearch() {
    st.hits = new Map();
    st.hitIds = [];
    st.hitIndex = -1;
    ui.searchInfo.textContent = '';
    ui.searchList.replaceChildren();
    placeAll();
  }

  function stepHit(dir) {
    if (!st.hitIds.length) return;
    st.hitIndex = (st.hitIndex + dir + st.hitIds.length) % st.hitIds.length;
    jumpTo(st.hitIds[st.hitIndex], false);
    ui.searchInfo.textContent = `${st.hitIndex + 1} of ${st.hitIds.length}`;
  }

  function jumpTo(id, play) {
    const li = st.els.get(`s:${id}`);
    const seg = st.segments.get(id);
    if (!li || !seg) return;
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
    if (ui.audio.src) seek(seg.start_ms, play);
  }

  ui.searchInput.addEventListener('input', runSearch);
  ui.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { ui.searchInput.value = ''; clearSearch(); }
  });

  // ---- keyboard ---------------------------------------------------------------------------
  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) {
      const sp = [...st.speakers.values()][Number(e.key) - 1];
      if (sp) { e.preventDefault(); setActive(sp.id); }
    } else if (e.key === '/') {
      e.preventDefault();
      ui.searchInput.focus();
    }
  }
  document.addEventListener('keydown', onKey);
  const onUnload = (e) => { if (st.recording || socket.pendingCount || socket.audioQueue.length) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);

  // ---- start ---------------------------------------------------------------------------
  renderRecorder();
  renderConn();
  renderDiag();
  loadAll().then(() => socket.connect());

  return () => {
    alive = false;
    clearInterval(connTick);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    closeMenus();
    if (st.recording) { recorder.stop(); socket.sendReliable({ type: 'record.stop' }).catch(() => {}); }
    setTimeout(() => socket.close(), st.recording ? 1500 : 0);
    document.body.classList.remove('is-recording');
    document.title = 'CourtScribe';
  };
}

-- CourtScribe schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number   text NOT NULL,
  title         text NOT NULL,
  courtroom     text,
  judge         text,
  status        text NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle', 'recording', 'paused', 'closed')),
  sample_rate   integer NOT NULL DEFAULT 16000,
  audio_samples integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Speakers belong to one hearing. "label" is what appears in the transcript
-- (e.g. "THE COURT", "MS. OKAFOR"); "role" is the courtroom function.
CREATE TABLE IF NOT EXISTS speakers (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  label       text NOT NULL,
  role        text NOT NULL DEFAULT 'Other',
  color       text NOT NULL DEFAULT '#6b7280',
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, label)
);

-- One utterance. Times are milliseconds into the hearing's audio track, so a
-- segment maps exactly onto the recording. client_id makes inserts idempotent
-- when a client resends after a reconnect.
CREATE TABLE IF NOT EXISTS segments (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker_id  integer REFERENCES speakers(id) ON DELETE SET NULL,
  client_id   uuid UNIQUE,
  start_ms    integer NOT NULL CHECK (start_ms >= 0),
  end_ms      integer NOT NULL CHECK (end_ms >= start_ms),
  text        text NOT NULL,
  source      text NOT NULL DEFAULT 'speech' CHECK (source IN ('speech', 'manual', 'import')),
  confidence  real,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX IF NOT EXISTS segments_session_time_idx ON segments (session_id, start_ms, id);
CREATE INDEX IF NOT EXISTS segments_search_idx ON segments USING gin (search);

-- Every edit keeps the previous version: a transcript of record needs an audit trail.
CREATE TABLE IF NOT EXISTS segment_revisions (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  segment_id  integer NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  text        text NOT NULL,
  speaker_id  integer,
  start_ms    integer NOT NULL,
  end_ms      integer NOT NULL,
  edited_by   text,
  replaced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS segment_revisions_segment_idx ON segment_revisions (segment_id, version);

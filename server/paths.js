import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where the database and recordings live. On Windows this defaults to
// %LOCALAPPDATA%\CourtScribe rather than the project folder: projects often
// sit under OneDrive (Desktop/Documents), and OneDrive's syncing locks the
// database files so PGlite cannot reopen them. Override with DATA_DIR.
export const dataDir = process.env.DATA_DIR
  || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CourtScribe')
    : path.join(projectRoot, 'data'));

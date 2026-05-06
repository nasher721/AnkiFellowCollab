import fs from 'node:fs/promises';
import path from 'node:path';
import { createSeedState } from './domain.mjs';

let saveQueue = Promise.resolve();

function dataDir() {
  return path.resolve(process.env.DECKBRIDGE_DATA_DIR || path.join(process.cwd(), '.deckbridge'));
}

export async function ensureDataDirs() {
  await fs.mkdir(path.join(dataDir(), 'uploads'), { recursive: true });
  await fs.mkdir(path.join(dataDir(), 'exports'), { recursive: true });
}

export function paths() {
  const root = dataDir();
  return {
    dataDir: root,
    statePath: path.join(root, 'state.json'),
    uploadsDir: path.join(root, 'uploads'),
    exportsDir: path.join(root, 'exports')
  };
}

export async function loadState() {
  await ensureDataDirs();
  try {
    const contents = await fs.readFile(paths().statePath, 'utf8');
    return JSON.parse(contents);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seeded = createSeedState();
    await saveState(seeded);
    return seeded;
  }
}

export async function saveState(state) {
  const nextSave = saveQueue.catch(() => undefined).then(async () => {
    await ensureDataDirs();
    const tempPath = path.join(paths().dataDir, `state.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, paths().statePath);
    return state;
  });
  saveQueue = nextSave.catch(() => undefined);
  return nextSave;
}

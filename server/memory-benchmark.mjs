import { createSeedState } from './domain.mjs';
import { loadState, saveState, ensureDataDirs, paths } from './store.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

async function runMemoryBenchmark() {
  const state = createSeedState();
  const deck = state.decks[0];

  for (let i = 0; i < 1000; i++) {
    deck.cards.push({
      ...deck.cards[0],
      id: `bench-${i}`,
      fields: {
        Front: `Benchmark card ${i} with some content for testing`,
        Back: `This is the answer for benchmark card ${i}`
      },
      createdAt: new Date(Date.now() + i).toISOString(),
    });
  }

  const dataDir = process.env.DECKBRIDGE_DATA_DIR || path.join(process.cwd(), '.deckbridge');
  await ensureDataDirs(dataDir);

  const tempState = { ...state, decks: [deck] };
  await saveState(tempState);

  console.log(`Deck: ${deck.name}`);
  console.log(`Total cards: ${deck.cards.length}`);
  console.log(`Total tags: ${new Set(deck.cards.flatMap(c => c.tags)).size}`);
  console.log(`Total suggestions: ${state.suggestions.length}`);
  console.log('Memory benchmark complete.');

  const statePath = path.join(dataDir, 'state.json');
  try { await fs.unlink(statePath); } catch {}
}

runMemoryBenchmark().catch(console.error);

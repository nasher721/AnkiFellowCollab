import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeParsedDeck } from './domain.mjs';

const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
process.env.ANKISKILL_PYTHON = python;
const { parseApkg } = await import('./ankiPackage.mjs');

async function createMultiTemplateApkg(apkgPath) {
  const script = String.raw`
import json, os, sqlite3, sys, time, zipfile

apkg_path = sys.argv[1]
workdir = os.path.dirname(apkg_path)
db_path = os.path.join(workdir, 'collection.anki2')
if os.path.exists(db_path):
    os.remove(db_path)

model_id = 1607392319000
deck_id = 2059400110
note_id = 1777777777000
now = int(time.time())
models = {
    str(model_id): {
        'id': model_id,
        'name': 'Basic (and reversed card)',
        'flds': [{'name': 'Front'}, {'name': 'Back'}],
        'tmpls': [
            {'name': 'Card 1', 'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'},
            {'name': 'Card 2', 'qfmt': '{{Back}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Front}}'},
        ],
        'css': '.card { color: navy; }',
    }
}
decks = {str(deck_id): {'id': deck_id, 'name': 'Multi Template Deck'}}

con = sqlite3.connect(db_path)
con.execute('create table col (models text, decks text)')
con.execute('create table notes (id integer, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text)')
con.execute('create table cards (id integer, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text)')
con.execute('insert into col (models, decks) values (?, ?)', (json.dumps(models), json.dumps(decks)))
con.execute(
    'insert into notes values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (note_id, 'multi-template-guid', model_id, now, -1, 'tag-one tag-two', 'Front value\x1fBack value', 'Front value', 0, 0, ''),
)
for ord_value in (0, 1):
    con.execute(
        'insert into cards values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (note_id + 10 + ord_value, note_id, deck_id, ord_value, now, -1, 0, 0, ord_value + 7, 0, 2500, 0, 0, 0, 0, 0, 0, ''),
    )
con.commit()
con.close()

with zipfile.ZipFile(apkg_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    package.write(db_path, 'collection.anki2')
`;
  execFileSync(python, ['-c', script, apkgPath]);
}

test('fallback APKG parser emits one DeckBridge card per Anki card ordinal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'deckbridge-apkg-'));
  const originalPath = process.env.PATH;
  try {
    const apkgPath = path.join(dir, 'multi-template.apkg');
    await createMultiTemplateApkg(apkgPath);

    process.env.PATH = dir;
    const parsed = await parseApkg(apkgPath);
    const deck = normalizeParsedDeck(parsed, 'multi-template.apkg');

    assert.equal(deck.cards.length, 2);
    assert.deepEqual(deck.cards.map((card) => card.id), ['1777777777000-0', '1777777777000-1']);
    assert.deepEqual(deck.cards.map((card) => card.ankiNoteId), [1777777777000, 1777777777000]);
    assert.deepEqual(deck.cards.map((card) => card.clozeOrd), [0, 1]);
    assert.deepEqual(deck.cards.map((card) => card.templateFront), ['{{Front}}', '{{Back}}']);
    assert.deepEqual(deck.cards.map((card) => card.type), ['Card 1', 'Card 2']);
    assert.deepEqual(deck.cards.map((card) => card.modelName), ['Basic (and reversed card)', 'Basic (and reversed card)']);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});

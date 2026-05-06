import { spawn } from 'node:child_process';

const ANKISKILL_PYTHON = process.env.ANKISKILL_PYTHON || '/Users/Nash/.local/share/uv/tools/ankiskill/bin/python';
const COMMAND_TIMEOUT_MS = Number(process.env.APKG_TOOL_TIMEOUT_MS || 30000);

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function runPython(script, args = []) {
  return runCommand(ANKISKILL_PYTHON, ['-c', script, ...args]);
}

export async function parseApkg(apkgPath) {
  try {
    const { stdout } = await runCommand('parse-deck', [apkgPath]);
    return JSON.parse(stdout);
  } catch (primaryError) {
    const { stdout } = await runPython(`
import json, os, sqlite3, sys, tempfile, zipfile

apkg_path = sys.argv[1]
with tempfile.TemporaryDirectory() as tempdir:
    with zipfile.ZipFile(apkg_path) as package:
        collection_name = 'collection.anki2' if 'collection.anki2' in package.namelist() else 'collection.anki21'
        package.extract(collection_name, tempdir)
    db_path = os.path.join(tempdir, collection_name)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    col = con.execute('select models, decks from col limit 1').fetchone()
    models = json.loads(col['models']) if col and col['models'] else {}
    decks = json.loads(col['decks']) if col and col['decks'] else {}
    deck_name = next((deck.get('name') for deck in decks.values() if deck.get('name') and deck.get('name') != 'Default'), None)
    if not deck_name:
        deck_name = next((deck.get('name') for deck in decks.values() if deck.get('name')), 'Imported Anki Deck')
    due_by_note = {}
    state_by_note = {}
    for card in con.execute('select nid, due, queue from cards'):
        due_by_note.setdefault(card['nid'], card['due'])
        queue = card['queue']
        state_by_note.setdefault(card['nid'], 'Suspended' if queue < 0 else 'New' if queue == 0 else 'Learning' if queue in (1, 3) else 'Review')
    cards = []
    for note in con.execute('select id, mid, flds, tags, mod from notes order by id'):
        model = models.get(str(note['mid']), {})
        field_names = [field.get('name', f'Field {i+1}') for i, field in enumerate(model.get('flds', []))]
        values = note['flds'].split('\\x1f')
        fields = {field_names[i] if i < len(field_names) else f'Field {i+1}': value for i, value in enumerate(values)}
        cards.append({
            'id': str(note['id']),
            'noteId': note['id'],
            'noteType': model.get('name', 'Basic'),
            'fields': fields,
            'tags': [tag for tag in note['tags'].split(' ') if tag],
            'due': due_by_note.get(note['id']),
            'state': state_by_note.get(note['id'], 'New')
        })
    print(json.dumps({'deck_name': deck_name, 'cards': cards}))
`, [apkgPath]);
    try {
      return JSON.parse(stdout);
    } catch (parseError) {
      parseError.message = `${parseError.message}; parse-deck also failed with: ${primaryError.message}`;
      throw parseError;
    }
  }
}

export async function createApkg(jsonPath, apkgPath) {
  try {
    return await runCommand('create-deck', [jsonPath, apkgPath]);
  } catch (_primaryError) {
    return runPython(`
import json, random, sys
import genanki

json_path, apkg_path = sys.argv[1], sys.argv[2]
with open(json_path, 'r', encoding='utf8') as handle:
    data = json.load(handle)

deck_id = random.randrange(1 << 30, 1 << 31)
deck = genanki.Deck(deck_id, data.get('deck_name') or 'DeckBridge Export')
for card in data.get('cards', []):
    card_type = str(card.get('type', 'basic')).lower()
    model = genanki.CLOZE_MODEL if 'cloze' in card_type else genanki.BASIC_AND_REVERSED_CARD_MODEL if 'reversed' in card_type else genanki.BASIC_MODEL
    if 'cloze' in card_type:
        fields = [card.get('front', ''), card.get('back', '')]
    else:
        fields = [card.get('front', ''), card.get('back', '')]
    note = genanki.Note(model=model, fields=fields, tags=card.get('tags', []))
    deck.add_note(note)
genanki.Package(deck).write_to_file(apkg_path)
`, [jsonPath, apkgPath]);
  }
}

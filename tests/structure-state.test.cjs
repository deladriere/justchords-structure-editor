const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() { this.children = []; this.checked = true; }
  set innerHTML(value) { this.children = []; }
  append(...items) { this.children.push(...items); }
}

function editor() {
  const root = process.env.EDITOR_TEST_ROOT || path.resolve(__dirname, '..');
  const fields = new Map();
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, new Element());
    return fields.get(id);
  };
  const context = {
    structuredClone, localStorage: { getItem() { return null; } }, navigator: {},
    document: { getElementById: field, createElement: () => new Element() }, confirm: () => true,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'library-check.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const boot = source.lastIndexOf('\nbindUi();');
  assert(boot >= 0, 'Locate app boot without running browser startup');
  vm.runInContext(source.slice(0, boot), context);
  const run = (code) => vm.runInContext(code, context);
  run('stopPlayback=()=>{}; showSaveStatus=()=>{}; renderLibraryCheck=()=>{}; render=()=>{state.song.hasStructure=songHasStructure(state.songIndex);renderSongSelect();renderNotice();};');
  context.library = {
    songs: [
      { id: 'A', title: 'A existing', rawData: 'Verse 1:\n[C]\n{chordbeats: 4}', structure: [{ type: 'section', sectionName: 'Verse 1' }] },
      { id: 'B', title: 'B missing', rawData: 'Verse 1:\n[C]\n{chordbeats: 4}' },
      { id: 'C', title: 'C MIDI only', rawData: 'Verse 1:\n[G]\n{chordbeats: 4}', structure: [{ type: 'midi', sectionName: '', midiTrigger: 'songAppear', midiRef: 'P', custom: 'keep' }] },
    ],
    midiLibraryMessages: [{ id: 'P', name: 'Patch test', midi: [] }],
  };
  run('loadLibrary(library,"test.json")');
  return { run, field, context, groups: () => Object.fromEntries(field('songSelect').children.map(g => [g.label, g.children.length])) };
}

test('building a structure identical to the preview enables export and updates picker/notice', () => {
  const { run, field, groups } = editor();
  assert.deepEqual(groups(), { 'With structure': 1, 'No structure yet': 2 });
  run('openSong(1)');
  assert.equal(run('pendingSongEdits().length'), 0);
  assert(field('notice').textContent.includes('no saved structure'));
  run('buildStructureFromSong()');
  assert.equal(run('state.song.hasStructure'), true);
  assert.equal(field('notice').textContent, '');
  assert.equal(run('pendingSongEdits().length'), 1);
  assert.equal(run('pendingSongEdits()[0].rawData'), undefined);
  assert.equal(run('pendingSongEdits()[0].structure[0].sectionName'), 'Verse 1');
  run('openSong(0); openSong(1)');
  assert.equal(run('state.song.hasStructure'), true);
  assert.equal(groups()['With structure'], 2);
  run('revertSong()');
  assert.equal(run('pendingSongEdits().length'), 0);
  assert.deepEqual(groups(), { 'With structure': 1, 'No structure yet': 2 });
});

test('structure-only bulk repairs persist, preserve MIDI, undo and survive JSON roundtrip', () => {
  const { run, field, groups, context } = editor();
  for (const key of ['headings', 'beats', 'whitespace']) field(`check-${key}`).checked = false;
  run('applyLibraryFixes()');
  assert.deepEqual(groups(), { 'With structure': 3 });
  assert.equal(run('pendingSongEdits().length'), 2);
  context.saved = JSON.parse(JSON.stringify(run('editedLibrary(pendingSongEdits(),"test-export")')));
  assert.equal(context.saved.songs[2].structure[0].custom, 'keep');
  assert.equal(context.saved.songs[2].structure[0].midiRef, 'P');
  for (let i = 0; i < 3; i++) {
    run(`openSong(${i})`);
    assert.equal(run('state.song.hasStructure'), true);
    assert(!field('notice').textContent.includes('no saved structure'));
  }
  run('undoLibraryFixes()');
  assert.deepEqual(groups(), { 'With structure': 1, 'No structure yet': 2 });
  assert.equal(run('pendingSongEdits().length'), 0);
  run('loadLibrary(saved,"roundtrip.json")');
  assert.deepEqual(groups(), { 'With structure': 3 });
  assert.equal(run('pendingSongEdits().length'), 0);
  assert.equal(run('state.library.songs[1].structure[0].sectionName'), 'Verse 1');
});

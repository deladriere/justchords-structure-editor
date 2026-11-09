'use strict';

const SECTION_COLORS = ['#ffb020', '#34c77b', '#d67ff0', '#1c9bf0', '#4cc9f0', '#a9a9b0', '#f26b6b', '#f5c400', '#c4a484', '#8a7ff0'];
const PRESET_COLORS = ['#ff9f0a', '#bf5af2', '#5e5ce6', '#30b0c7', '#d35c75', '#398563', '#a96b27'];
const ZERO_BEAT_HEIGHT = 60;
const MIN_BLOCK_HEIGHT = 60;
const RAW_HEIGHT = 32;
const GROUP_HEIGHT = 26;
const MAX_DELAY = 100;
const TICK_MS = 25;
const LOOKAHEAD_MS = 100;
const START_LEAD_MS = 80;
const CHORD_CHANNEL = 1;
const DEFAULT_CHORD_BEATS = 4;

const settings = {
  midiOut: localStorage.getItem('jc.midiOut') || 'all',
  chords: localStorage.getItem('jc.chords') !== 'off',
  velocity: Number(localStorage.getItem('jc.velocity')) || 90,
  clock: localStorage.getItem('jc.clock') === 'on',
  countIn: Number(localStorage.getItem('jc.countIn')) || 0,
};

function saveSetting(key, value) {
  settings[key] = value;
  localStorage.setItem('jc.' + key, typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));
}

const state = {
  midi: null,
  midiStatus: '',
  displayed: false,
  tappedUid: null,
  sourceLabel: '',
  library: null,
  presets: new Map(),
  presetEdits: new Map(),
  songs: [],
  songIndex: -1,
  song: null,
  arr: null,
  original: '',
  edits: new Map(),
  textEdits: new Map(),
  layout: [],
  selectedUid: null,
  ppb: 8,
  drag: null,
  drop: null,
  play: null,
  openGroups: new Set(['song']),
  query: '',
};

const $ = (id) => document.getElementById(id);
let uidCounter = 0;
const uid = () => 'u' + (++uidCounter);
let ordCounter = 1e6;
const nextOrd = () => ++ordCounter;

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------------- chart parsing ---------------- */

const LABEL_RE = /^([^\[\]{}()]+):$/;
const labelOf = (line) => line.trim().match(LABEL_RE)?.[1].trim() || null;

function duplicateLabels(raw) {
  const counts = new Map();
  for (const name of String(raw || '').split('\n').map(labelOf).filter(Boolean)) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([name]) => name);
}

function numberDuplicateLabels(raw) {
  const text = String(raw || '');
  const dups = new Set(duplicateLabels(text));
  const renames = [];
  if (!dups.size) return { text, renames };
  const lines = text.split('\n');
  const taken = new Set(lines.map(labelOf).filter(Boolean));
  const seen = new Map();
  const numbered = (name, k) => (/\d$/.test(name) ? `${name}${'abcdefghijklmnopqrstuvwxyz'[k - 1] || k}` : `${name} ${k}`);
  const out = lines.map((line) => {
    const name = labelOf(line);
    if (!name || !dups.has(name)) return line;
    let k = seen.get(name) || 0;
    let next;
    do { k += 1; next = numbered(name, k); } while (taken.has(next));
    seen.set(name, k);
    taken.add(next);
    renames.push([name, next]);
    return line.replace(name, next);
  });
  return { text: out.join('\n'), renames };
}

function parseChart(raw) {
  const sections = new Map();
  let current = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { current = null; continue; }
    const label = trimmed.match(LABEL_RE);
    if (label) {
      const name = label[1].trim();
      current = sections.get(name) || { name, lines: [] };
      sections.set(name, current);
      continue;
    }
    if (current) current.lines.push(trimmed);
  }

  let index = 0;
  for (const sec of sections.values()) {
    const text = sec.lines.join('\n');
    const symbols = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const beatDirectives = [...text.matchAll(/\{\s*chordbeats\s*:\s*([^}]*)\}/gi)];
    const beatList = beatDirectives.flatMap((m) => m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    sec.usesDefaultBeats = !beatDirectives.length && symbols.length > 0;
    let at = 0;
    sec.chords = symbols.map((symbol, i) => {
      const beats = Number.isFinite(beatList[i]) ? beatList[i] : (sec.usesDefaultBeats ? DEFAULT_CHORD_BEATS : 0);
      const chord = { symbol, beats, at };
      at += beats;
      return chord;
    });
    sec.beats = at;
    // Keep complete source lines, anchored to their first chord's beat.
    // Lines without chords share the preceding lyric anchor: they have no
    // independent timing information in the chart.
    sec.lyrics = [];
    let chordIndex = 0;
    let lyricAt = 0;
    for (const line of sec.lines) {
      const count = [...line.matchAll(/\[([^\]]+)\]/g)].length;
      const firstChord = sec.chords[chordIndex];
      chordIndex += count;
      if (line.startsWith('{') || line.startsWith('(')) continue;
      const lyric = line.replace(/\{[^}]*\}/g, '').replace(/\[[^\]]+\]/g, '').trim();
      if (count) lyricAt = firstChord.at;
      if (!lyric) continue;
      const previous = sec.lyrics.at(-1);
      if (previous?.at === lyricAt) previous.text += '\n' + lyric;
      else sec.lyrics.push({ at: lyricAt, text: lyric });
    }
    sec.color = SECTION_COLORS[index % SECTION_COLORS.length];
    index += 1;
    delete sec.lines;
  }
  return sections;
}

/* ---------------- structure <-> arrangement ---------------- */

function parseStructure(items) {
  const arr = { load: [], steps: [], trailing: [] };
  let pending = [];
  let lastSection = null;

  (items || []).forEach((item, ord) => {
    if (item.type === 'midi' && (!item.midiTrigger || item.midiTrigger === 'songAppear' || item.midiTrigger === 'sectionDeselect')) {
      const ev = { uid: uid(), midiRef: item.midiRef, delay: item.midiDelay || 0, ord, raw: item };
      if (item.midiTrigger === 'songAppear') {
        ev.trigger = 'load';
        arr.load.push(ev);
      } else if (item.midiTrigger === 'sectionDeselect') {
        ev.trigger = 'deselect';
        if (lastSection) lastSection.deselect.push(ev);
        else arr.trailing.push(ev);
      } else {
        ev.trigger = 'select';
        pending.push(ev);
      }
    } else if (item.type === 'section') {
      lastSection = { uid: uid(), kind: 'section', name: item.sectionName, select: pending, deselect: [], raw: item };
      pending = [];
      arr.steps.push(lastSection);
    } else {
      arr.steps.push({ uid: uid(), kind: 'raw', raw: item, select: [], deselect: [] });
    }
  });
  arr.trailing.push(...pending);
  return arr;
}

function defaultArrangement(chart) {
  return {
    load: [],
    trailing: [],
    steps: [...chart.keys()].map((name) => ({ uid: uid(), kind: 'section', name, select: [], deselect: [], raw: {} })),
  };
}

function eventItem(ev) {
  const item = { ...ev.raw, type: 'midi', sectionName: ev.raw.sectionName ?? '', midiRef: ev.midiRef };
  const keepTrigger = ev.trigger === 'select' && ev.raw.midiTrigger && ev.raw.midiTrigger !== 'songAppear' && ev.raw.midiTrigger !== 'sectionDeselect';
  if (!keepTrigger) delete item.midiTrigger;
  if (ev.trigger === 'load') item.midiTrigger = 'songAppear';
  if (ev.trigger === 'deselect') item.midiTrigger = 'sectionDeselect';

  delete item.midiDelay;
  const keepExplicitDelay = 'midiDelay' in ev.raw && ev.raw.midiDelay === ev.delay;
  if (ev.trigger !== 'load' && (ev.delay > 0 || keepExplicitDelay)) item.midiDelay = ev.delay;
  return item;
}

function serialize(arr) {
  const byOrd = (a, b) => a.ord - b.ord;
  const out = [];
  const pushGap = (events) => events.slice().sort(byOrd).forEach((ev) => out.push(eventItem(ev)));

  pushGap([...arr.load, ...(arr.steps[0]?.select || [])]);
  arr.steps.forEach((step, i) => {
    out.push(step.kind === 'section' ? { ...step.raw, type: 'section', sectionName: step.name } : step.raw);
    pushGap([...step.deselect, ...(arr.steps[i + 1]?.select || [])]);
  });
  pushGap(arr.trailing);
  return out;
}

/* ---------------- presets ---------------- */

function presetLabel(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  // Delimited labels can contain several words (e.g. "Pico Drum").
  // A numbered prefix such as "Patch 05 · Warm Pad" belongs to "Patch".
  const prefix = clean.split(/[·:]/, 1)[0].trim();
  const title = (/[·:]/.test(clean) ? prefix.replace(/\s+\d.*$/, '') : prefix.split(' ')[0]) || 'Other';
  return { id: 'label:' + norm(title), title };
}

function presetColor(preset) {
  if (!preset) return 'var(--other)';
  const key = presetLabel(preset.name).id;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return PRESET_COLORS[hash % PRESET_COLORS.length];
}

function songPresetParts(name) {
  const m = String(name || '').match(/^\s*([^·:]+?)\s*·\s*(.+?)\s*·\s*(.+?)\s*$/);
  return m ? { label: m[1].replace(/\s+/g, ' ').trim(), song: m[2].trim(), part: m[3].trim() } : null;
}

function shortName(preset) {
  if (!preset) return 'Missing preset';
  const parts = songPresetParts(preset.name);
  if (!parts) return preset.name;
  return norm(parts.song) === norm(state.song?.title) ? `${parts.label} · ${parts.part}` : `${parts.label} · ${parts.song} · ${parts.part}`;
}

function midiChannel(message) {
  return Math.max(1, Math.min(16, Number(message.channel ?? 0) + 1));
}

function messageBody(m) {
  const type = (m.status ?? 0) & 0xf0;
  if (type === 0xb0) return `CC${m.data1}=${m.data2}`;
  if (type === 0xc0) return `PC ${m.data1}`;
  if (type === 0x90) return `Note On ${m.data1} v${m.data2}`;
  if (type === 0x80) return `Note Off ${m.data1}`;
  if (type === 0xe0) return `Bend ${m.data1}/${m.data2}`;
  return `0x${(m.status ?? 0).toString(16)} ${m.data1 ?? ''} ${m.data2 ?? ''}`.trim();
}

function describeMessages(midi) {
  if (!midi || !midi.length) return '(no messages)';
  const channels = new Set(midi.map(midiChannel));
  if (channels.size === 1) return `${midi.map(messageBody).join(' · ')} · ch ${[...channels][0]}`;
  return midi.map((m) => `${messageBody(m)} ch${midiChannel(m)}`).join(' · ');
}

function messageBytes(m) {
  const type = (m.status ?? 0) & 0xf0;
  const status = type | (midiChannel(m) - 1);
  const d1 = (m.data1 ?? 0) & 0x7f;
  if (type === 0xc0 || type === 0xd0) return [status, d1];
  return [status, d1, (m.data2 ?? 0) & 0x7f];
}

/* ---------------- chord voicing ---------------- */

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function pitchClass(letter, accidental) {
  return (PITCH[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
}

function chordIntervals(quality) {
  const q = quality.replace(/\s+/g, '');
  if (/^(maj7|M7|Δ)/.test(q)) return [0, 4, 7, 11];
  if (/^(m7b5|ø)/.test(q)) return [0, 3, 6, 10];
  if (/^dim7/.test(q)) return [0, 3, 6, 9];
  if (/^(dim|°)/.test(q)) return [0, 3, 6];
  if (/^(aug|\+)/.test(q)) return [0, 4, 8];
  if (/^5$/.test(q)) return [0, 7];

  const minor = /^(m|min|-)(?!aj)/.test(q);
  let notes = minor ? [0, 3, 7] : [0, 4, 7];
  if (/sus2/.test(q)) notes = [0, 2, 7];
  else if (/sus/.test(q)) notes = [0, 5, 7];
  if (/maj7|M7/.test(q.slice(minor ? 1 : 0))) notes.push(11);
  else if (/7|9|11|13/.test(q) && !/add/.test(q)) notes.push(10);
  if (/6/.test(q) && !/7/.test(q)) notes.push(9);
  if (/add9|(?<!add)9/.test(q)) notes.push(14);
  return notes;
}

function chordNotes(symbol) {
  const m = String(symbol).trim().replace(/♯/g, '#').replace(/♭/g, 'b')
    .match(/^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/);
  if (!m) return null;
  const rootNote = 48 + pitchClass(m[1], m[2]);
  const notes = chordIntervals(m[3]).map((i) => rootNote + i);
  if (m[4]) {
    let bass = 36 + pitchClass(m[4], m[5]);
    if (bass >= rootNote) bass -= 12;
    notes.unshift(bass);
  }
  return [...new Set(notes)].sort((a, b) => a - b);
}

const noteName = (n) => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

/* ---------------- loading ---------------- */

function loadLibrary(library, label) {
  if (!library || !Array.isArray(library.songs) || !library.songs.length
    || library.songs.some((song) => !song || typeof song.id !== 'string' || typeof song.title !== 'string'
      || (song.structure !== undefined && !Array.isArray(song.structure)))
    || new Set(library.songs.map((song) => song.id)).size !== library.songs.length
    || (library.midiLibraryMessages !== undefined && (!Array.isArray(library.midiLibraryMessages)
      || library.midiLibraryMessages.some((preset) => !preset || typeof preset.id !== 'string'
        || typeof preset.name !== 'string' || !Array.isArray(preset.midi))))) {
    throw new Error('Choose a JustChords library.json containing songs with unique IDs and a MIDI library.');
  }
  stopPlayback();
  state.songIndex = -1;
  state.arr = null;
  // Keep an untouched snapshot of every JSON field for the downloaded copy.
  state.library = structuredClone(library);
  state.sourceLabel = label;
  state.presets = new Map((library.midiLibraryMessages || []).map((p) => [p.id, { ...p }]));
  state.presetEdits = new Map();
  $('newPresetBtn').disabled = false;
  const names = new Map();
  for (const p of state.presets.values()) names.set(p.name, (names.get(p.name) || 0) + 1);
  for (const p of state.presets.values()) p.duplicate = names.get(p.name) > 1;

  state.songs = (library.songs || []).slice().sort((a, b) => a.title.trim().localeCompare(b.title.trim()));
  state.edits = new Map();
  state.textEdits = new Map();
  const select = $('songSelect');
  select.innerHTML = '';
  const withStructure = el('optgroup');
  withStructure.label = 'With structure';
  const without = el('optgroup');
  without.label = 'No structure yet';
  state.songs.forEach((s, i) => {
    const option = el('option', '', s.title.trim() + (s.artist ? ` — ${s.artist.trim()}` : ''));
    option.value = i;
    (s.structure ? withStructure : without).append(option);
  });
  select.append(withStructure, without);

  const preferred = state.songs.findIndex((s) => s.structure);
  openSong(preferred >= 0 ? preferred : 0);
}

function openSong(index) {
  stopPlayback();
  if (state.songIndex >= 0 && state.arr) state.edits.set(state.songIndex, state.arr);

  const raw = state.songs[index];
  state.songIndex = index;
  $('songSelect').value = index;
  const ts = String(raw.timeSignature || '4/4');
  const rawData = state.textEdits.get(index)?.text ?? raw.rawData;
  state.song = {
    title: raw.title.trim(),
    artist: (raw.artist || '').trim(),
    bpm: parseFloat(raw.tempo) || 120,
    tempoKnown: !!parseFloat(raw.tempo),
    ts,
    beatsPerBar: parseInt(ts, 10) || 4,
    key: raw.keyChord?.key ? `${raw.keyChord.key}${raw.keyChord.minor ? ' minor' : ' major'}` : '',
    rawData,
    chart: parseChart(rawData),
    duplicates: duplicateLabels(rawData),
    hasStructure: Array.isArray(raw.structure),
  };
  state.original = baselineOf(raw);
  state.arr = state.edits.get(index)
    || (raw.structure ? parseStructure(raw.structure) : defaultArrangement(state.song.chart));
  state.selectedUid = null;
  state.displayed = false;
  state.tappedUid = null;
  render();
}

// A song without a structure is shown in text order; that alone is not a change.
function baselineOf(raw) {
  return raw.structure ? canonical(raw.structure) : canonical(serialize(defaultArrangement(parseChart(raw.rawData))));
}

function songDirty(index) {
  const arr = index === state.songIndex ? state.arr : state.edits.get(index);
  if (state.textEdits.has(index)) return true;
  return !!arr && canonical(serialize(arr)) !== baselineOf(state.songs[index]);
}

function dirtySongs() {
  const indices = new Set([...state.edits.keys(), ...state.textEdits.keys(), state.songIndex]);
  return [...indices].filter((i) => i >= 0 && songDirty(i)).sort((a, b) => a - b);
}

function showSaveStatus(text, ok) {
  const box = $('saveStatus');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('ok', !!ok);
}

function pendingSongEdits() {
  return dirtySongs().map((i) => {
    const arr = i === state.songIndex ? state.arr : state.edits.get(i);
    const edit = { id: state.songs[i].id, structure: serialize(arr) };
    const text = state.textEdits.get(i)?.text;
    if (text !== undefined) edit.rawData = text;
    return edit;
  });
}

function editedLibrary(edits, dataVersion) {
  const copy = structuredClone(state.library);
  for (const edit of edits) {
    const song = copy.songs.find((item) => item.id === edit.id);
    if (!song) throw new Error('A changed song is missing from the imported library.');
    song.structure = structuredClone(edit.structure);
    if (edit.rawData !== undefined) song.rawData = edit.rawData;
  }
  if (state.presetEdits.size) {
    copy.midiLibraryMessages ||= [];
    for (const preset of state.presetEdits.values()) {
      const index = copy.midiLibraryMessages.findIndex((p) => p.id === preset.id);
      if (index < 0) copy.midiLibraryMessages.push(structuredClone(preset));
      else copy.midiLibraryMessages[index] = structuredClone(preset);
    }
  }
  copy.dataVersion = dataVersion;
  return copy;
}

function downloadLibrary() {
  const edits = pendingSongEdits();
  if (!edits.length && !state.presetEdits.size) return;
  stopPlayback();
  const copy = editedLibrary(edits, crypto.randomUUID().toUpperCase());
  const text = JSON.stringify(copy).replace(/\//g, '\\/');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = 'library-edited.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const changes = [edits.length && plural(edits.length, 'changed song'), state.presetEdits.size && plural(state.presetEdits.size, 'changed MIDI preset')].filter(Boolean).join(' and ');
  showSaveStatus(`Downloaded library-edited.json with ${changes}. Your original JSON file is unchanged.`, true);
}

function revertSong() {
  state.edits.delete(state.songIndex);
  state.textEdits.delete(state.songIndex);
  state.arr = null;
  const index = state.songIndex;
  state.songIndex = -1;
  openSong(index);
}

function buildStructureFromSong() {
  const events = state.arr.steps.reduce((n, s) => n + s.select.length + s.deselect.length, 0);
  if (events && !confirm(`Rebuild the structure from the song text? The ${plural(events, 'section MIDI event')} on the timeline will be removed. Song Appear presets are kept.`)) return;
  mutate(() => {
    const index = state.songIndex;
    const { text, renames } = numberDuplicateLabels(state.song.rawData);
    if (renames.length) {
      const before = state.textEdits.get(index)?.renames || [];
      state.textEdits.set(index, { text, renames: [...before, ...renames] });
      state.song.rawData = text;
      state.song.chart = parseChart(text);
      state.song.duplicates = [];
    }
    state.arr = { load: state.arr.load, trailing: state.arr.trailing, steps: defaultArrangement(state.song.chart).steps };
    state.selectedUid = null;
    state.tappedUid = null;
  });
}

function renameSummary(renames) {
  const byName = new Map();
  for (const [from, to] of renames) byName.set(from, [...(byName.get(from) || []), to]);
  return [...byName].map(([from, tos]) => `“${from}” → ${tos.map((t) => `“${t}”`).join(', ')}`).join('; ');
}

/* ---------------- section text editor ---------------- */

let editingSection = null;

function sectionTextRange(raw, name) {
  const lines = raw.split('\n');
  const header = lines.findIndex((line) => labelOf(line) === name);
  if (header < 0) return null;
  const start = lines.slice(0, header + 1).reduce((n, line) => n + line.length + 1, 0);
  let end = start;
  for (let i = header + 1; i < lines.length; i += 1) {
    if (!lines[i].trim() || labelOf(lines[i])) break;
    end += lines[i].length + 1;
  }
  return { start: Math.min(start, raw.length), end: Math.min(end, raw.length) };
}

function openSectionEditor(name) {
  const raw = state.song.rawData || '';
  const range = sectionTextRange(raw, name);
  if (!range || state.song.duplicates.includes(name)) return;
  const text = raw.slice(range.start, range.end).replace(/\r?\n$/, '').replace(/\r\n/g, '\n');
  editingSection = { name, range, text };
  $('sectionDialogTitle').textContent = `Edit section · ${name}`;
  $('sectionText').value = text;
  $('sectionError').hidden = true;
  updateSectionTiming();
  $('sectionDialog').showModal();
  $('sectionText').focus();
}

function updateSectionTiming() {
  const text = $('sectionText').value;
  const section = parseChart(`Section:\n${text}`).get('Section');
  const chords = section?.chords.length || 0;
  const values = [...text.matchAll(/\{\s*chordbeats\s*:\s*([^}]*)\}/gi)]
    .flatMap((match) => match[1].trim().split(/\s+/).filter(Boolean));
  let summary = `${plural(chords, 'chord')} · ${section?.beats || 0} beats`;
  if (section?.beats && section.beats % state.song.beatsPerBar === 0) summary += ` · ${section.beats / state.song.beatsPerBar} bars`;
  if (section?.usesDefaultBeats) summary += ` · default: ${DEFAULT_CHORD_BEATS} beats per chord`;
  else if (!values.length) summary += ' · no chord beats assigned';
  else if (values.length !== chords) summary += ` · ${values.length} beat values for ${chords} chords; ${values.length > chords ? 'extra values are unused' : 'remaining chords have 0 beats'}`;
  $('sectionTiming').textContent = summary;
  $('defaultBeatsHelp').hidden = !section?.usesDefaultBeats;
  $('sectionError').hidden = true;
}

function defaultChordBeatInstruction(count) {
  return `{chordbeats: ${Array(count).fill(DEFAULT_CHORD_BEATS).join(' ')}}`;
}

function fillMissingChordBeats(raw) {
  const text = String(raw || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const insertions = [];
  let start = null;
  const finish = (end) => {
    if (start === null) return;
    const body = text.slice(start, end);
    const section = parseChart(`Section:\n${body}`).get('Section');
    if (section?.usesDefaultBeats) {
      const endsWithNewline = body.endsWith('\n');
      insertions.push({ at: end, text: `${endsWithNewline ? '' : eol}${defaultChordBeatInstruction(section.chords.length)}${endsWithNewline ? eol : ''}` });
    }
    start = null;
  };
  // Visit each source block separately, including repeated section labels.
  // Insert at source offsets to preserve all existing text and timing exactly.
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$/, '');
    if (LABEL_RE.test(line.trim())) {
      finish(match.index);
      start = match.index + match[0].length;
    } else if (!line.trim()) finish(match.index);
  }
  finish(text.length);
  let replacement = text;
  for (let i = insertions.length - 1; i >= 0; i -= 1) {
    const edit = insertions[i];
    replacement = replacement.slice(0, edit.at) + edit.text + replacement.slice(edit.at);
  }
  return { text: replacement, count: insertions.length };
}

function fillSongChordBeats() {
  if (!state.song) return;
  const filled = fillMissingChordBeats(state.song.rawData);
  if (!filled.count) return;
  mutate(() => {
    const previous = state.textEdits.get(state.songIndex) || {};
    state.textEdits.set(state.songIndex, { ...previous, text: filled.text });
    state.song.rawData = filled.text;
    state.song.chart = parseChart(filled.text);
    state.song.duplicates = duplicateLabels(filled.text);
  });
  showSaveStatus(`Added 4 beats per chord to ${plural(filled.count, 'section')} in this song. Existing timing was kept. Download an edited copy to save the changes.`, true);
}

function setDefaultChordBeats() {
  const text = $('sectionText').value;
  const section = parseChart(`Section:\n${text}`).get('Section');
  // Only write assumed timing; never replace an existing instruction.
  if (!editingSection || !section?.usesDefaultBeats) return;
  $('sectionText').value = `${text.trimEnd()}\n${defaultChordBeatInstruction(section.chords.length)}`;
  updateSectionTiming();
  $('sectionText').focus();
}

function saveSectionText(e) {
  e.preventDefault();
  if (!editingSection) return;
  const text = $('sectionText').value;
  const showError = (message) => {
    $('sectionError').textContent = message;
    $('sectionError').hidden = false;
    $('sectionText').focus();
  };
  if (text === editingSection.text) { $('sectionDialog').close(); return; }
  if (text.split('\n').some((line) => labelOf(line))) {
    showError('Edit the content of this section here. Do not add another section label.');
    return;
  }
  // A blank line ends a section in the chart parser. Avoid saving directives
  // which look valid in this editor but would sit outside the named section.
  if (text.trimEnd().split('\n').some((line) => !line.trim()) && text.trim()) {
    showError('Keep this section’s content together: remove blank lines before its chords, lyrics or chordbeats directive.');
    return;
  }
  const values = [...text.matchAll(/\{\s*chordbeats\s*:\s*([^}]*)\}/gi)]
    .flatMap((match) => match[1].trim().split(/\s+/).filter(Boolean));
  if (values.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    showError('Chord beats must be whole numbers of 0 or more, separated by spaces.');
    return;
  }
  const raw = state.song.rawData || '';
  const { name, range } = editingSection;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const content = text.replace(/\n+$/, '').replace(/\n/g, eol);
  let before = raw.slice(0, range.start);
  if (before && !before.endsWith('\n')) before += eol;
  const suffix = raw.slice(range.end);
  const replacement = before + content + ((suffix || raw.slice(range.start, range.end).endsWith('\n')) ? eol : '') + suffix;
  mutate(() => {
    const previous = state.textEdits.get(state.songIndex) || {};
    if (replacement === state.songs[state.songIndex].rawData) state.textEdits.delete(state.songIndex);
    else state.textEdits.set(state.songIndex, { ...previous, text: replacement });
    state.song.rawData = replacement;
    state.song.chart = parseChart(replacement);
    state.song.duplicates = duplicateLabels(replacement);
  });
  $('sectionDialog').close();
  showSaveStatus(`Updated “${name}”. Download an edited copy to keep the section text and chord beats.`, true);
}

/* ---------------- layout & timing ---------------- */

function stepBeats(step) {
  return step.kind === 'section' ? (state.song.chart.get(step.name)?.beats || 0) : 0;
}

function eventGroups(step) {
  const groups = new Map();
  const add = (ev) => {
    const key = ev.trigger + ':' + ev.delay;
    if (!groups.has(key)) groups.set(key, { trigger: ev.trigger, delay: ev.delay, events: [] });
    groups.get(key).events.push(ev);
  };
  step.select.forEach(add);
  step.deselect.forEach(add);
  return [...groups.values()];
}

function computeLayout() {
  let start = 0;
  // Measure wrapped lyrics using the same column width and typography as the
  // track. A denser chart can expand visually without changing its beat count.
  const measure = el('div', 'lyric-row lyric-measure');
  document.body.append(measure);
  const lyricHeights = new Map();
  for (const sec of state.song.chart.values()) {
    lyricHeights.set(sec.name, sec.lyrics.map((line) => {
      measure.textContent = line.text;
      return measure.getBoundingClientRect().height;
    }));
  }
  measure.remove();
  state.layout = state.arr.steps.map((step) => {
    const beats = stepBeats(step);
    const groups = eventGroups(step);
    let h;
    if (step.kind === 'raw') h = RAW_HEIGHT;
    else if (!beats) h = ZERO_BEAT_HEIGHT;
    else h = Math.max(beats * state.ppb, MIN_BLOCK_HEIGHT);
    h = Math.max(h, groups.length * (GROUP_HEIGHT + 2) + 4);
    const lyrics = state.song.chart.get(step.name)?.lyrics || [];
    lyrics.forEach((line, i) => {
      const next = lyrics[i + 1];
      const needed = lyricHeights.get(step.name)[i] + (next ? 8 : 24);
      const span = (next?.at ?? beats) - line.at;
      h = Math.max(h, beats && span > 0 ? Math.ceil(needed * beats / span) : needed);
    });
    const entry = { start, beats, h, groups };
    start += beats;
    return entry;
  });
  state.totalBeats = start;
}

function beatY(L, beat, trigger) {
  if (!L.beats) return trigger === 'deselect' ? L.h : 0;
  return (Math.min(Math.max(beat, 0), L.beats) / L.beats) * L.h;
}

function eventOffsetBeat(L, trigger, delay) {
  return trigger === 'select' ? Math.min(delay, L.beats) : Math.max(L.beats - delay, 0);
}

function barBeat(absBeat) {
  const bpb = state.song.beatsPerBar;
  const whole = Math.round(absBeat);
  return `bar ${Math.floor(whole / bpb) + 1} · beat ${(whole % bpb) + 1}`;
}

function timingText(stepName, trigger, delay) {
  if (trigger === 'load') return 'When song is displayed';
  if (trigger === 'select') {
    return delay ? `At ${stepName} selection · delay ${plural(delay, 'beat')}` : `At ${stepName} selection`;
  }
  return delay ? `At ${stepName} deselection · anticipation ${plural(delay, 'beat')}` : `At ${stepName} deselection`;
}

function formatDuration(beats, bpm) {
  const seconds = Math.round((beats * 60) / bpm);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/* ---------------- event helpers ---------------- */

function allEvents() {
  const out = [...state.arr.load, ...state.arr.trailing];
  state.arr.steps.forEach((s) => out.push(...s.select, ...s.deselect));
  return out;
}

function findEvent(id) {
  for (const ev of state.arr.load) if (ev.uid === id) return { ev, step: null, list: state.arr.load };
  for (const step of state.arr.steps) {
    for (const list of [step.select, step.deselect]) {
      const ev = list.find((e) => e.uid === id);
      if (ev) return { ev, step, list };
    }
  }
  const ev = state.arr.trailing.find((e) => e.uid === id);
  return ev ? { ev, step: null, list: state.arr.trailing } : null;
}

function detachEvent(id) {
  const found = findEvent(id);
  if (!found) return null;
  found.list.splice(found.list.indexOf(found.ev), 1);
  return found.ev;
}

function placeEvent(ev, step, trigger, delay) {
  ev.trigger = trigger;
  ev.delay = trigger === 'load' ? 0 : Math.max(0, Math.min(MAX_DELAY, delay));
  ev.ord = nextOrd();
  if (trigger === 'load') state.arr.load.push(ev);
  else (trigger === 'select' ? step.select : step.deselect).push(ev);
}

function newEvent(midiRef) {
  return { uid: uid(), midiRef, delay: 0, ord: nextOrd(), raw: {} };
}

function usageCounts() {
  const counts = new Map();
  for (const ev of allEvents()) counts.set(ev.midiRef, (counts.get(ev.midiRef) || 0) + 1);
  return counts;
}

function mutate(fn) {
  stopPlayback();
  fn();
  render();
}

/* ---------------- rendering ---------------- */

function render() {
  computeLayout();
  renderTransport();
  renderMeta();
  renderPalette();
  renderLoadZone();
  renderNotice();
  renderTrack();
  renderLibrary();
  renderInspector();
}

function renderMeta() {
  const s = state.song;
  const parts = [s.artist, s.key, s.tempoKnown ? `${s.bpm} bpm` : 'no tempo (preview at 120)', s.ts];
  if (state.totalBeats) parts.push(`${state.totalBeats} beats ≈ ${formatDuration(state.totalBeats, s.bpm)}`);
  $('songMeta').textContent = parts.filter(Boolean).join(' · ');

  const dirty = songDirty(state.songIndex);
  $('dirtyBadge').hidden = !dirtySongs().length && !state.presetEdits.size;
  $('revertBtn').hidden = !dirty;

  const pending = dirtySongs().length + state.presetEdits.size;
  $('downloadBtn').disabled = !pending;
  $('downloadBtn').title = pending
    ? 'Download a separate JSON copy with your edits; the original file stays unchanged'
    : 'Edit the structure, MIDI events or library presets to download an edited copy';
}

function sectionPill(name, draggable) {
  const color = state.song.chart.get(name)?.color || '#8e8e93';
  const pill = el('span', 'section-pill', name);
  pill.style.background = color;
  pill.draggable = draggable;
  return pill;
}

function renderPalette() {
  const box = $('sectionPalette');
  box.innerHTML = '';
  for (const name of state.song.chart.keys()) {
    const pill = sectionPill(name, true);
    pill.title = `Click to append “${name}” · drag to insert`;
    pill.addEventListener('click', () => mutate(() => {
      state.arr.steps.push({ uid: uid(), kind: 'section', name, select: [], deselect: [], raw: {} });
    }));
    pill.addEventListener('dragstart', (e) => startDrag(e, { kind: 'newStep', name }));
    box.append(pill);
  }
  if (!state.song.chart.size) box.append(el('span', 'hint', 'No labelled sections in this chart.'));
  const build = $('buildBtn');
  const steps = state.arr.steps;
  const names = [...state.song.chart.keys()];
  const inTextOrder = steps.length === names.length && steps.every((s, i) => s.kind === 'section' && s.name === names[i]);
  const upToDate = state.song.hasStructure && inTextOrder && !state.song.duplicates.length;
  build.disabled = !names.length || upToDate;
  build.title = !names.length ? 'No labelled sections in this chart'
    : upToDate ? 'The structure already follows the song text: nothing to build'
    : 'Number duplicate section names in the song text, then add every section in text order';
  const missingBeats = fillMissingChordBeats(state.song.rawData).count;
  const fill = $('fillSongBeatsBtn');
  fill.disabled = !missingBeats;
  fill.title = missingBeats
    ? `Add 4 beats per chord to ${plural(missingBeats, 'section')} in this song without a chordbeats instruction. Existing timing is kept.`
    : 'No sections in this song need default beat instructions';
}

function chipEl(ev, stepName) {
  const preset = state.presets.get(ev.midiRef);
  const chip = el('div', 'chip');
  chip.dataset.uid = ev.uid;
  chip.draggable = true;
  if (!preset) chip.classList.add('missing');
  if (ev.uid === state.selectedUid) chip.classList.add('selected');
  chip.title = `${preset ? preset.name : ev.midiRef}\n${timingText(stepName, ev.trigger, ev.delay)}\n${preset ? describeMessages(preset.midi) : ''}`;

  const kind = el('span', 'kind ' + ev.trigger, { load: 'PRE', select: 'IN', deselect: 'OUT' }[ev.trigger]);
  const dot = el('span', 'dot');
  dot.style.background = presetColor(preset);
  chip.append(kind, dot, el('span', '', shortName(preset)));

  if (ev.delay && ev.trigger !== 'load') {
    chip.append(el('span', 'off', (ev.trigger === 'select' ? '+' : '−') + ev.delay));
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selectedUid = ev.uid;
    render();
  });
  chip.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    startDrag(e, { kind: 'event', uid: ev.uid });
  });
  return chip;
}

function renderTransport() {
  const pill = $('displayState');
  pill.textContent = state.displayed ? 'Displayed' : 'Song not displayed';
  pill.classList.toggle('on', state.displayed);
  $('loadZone').classList.toggle('displayed', state.displayed);
  const status = $('midiStatus');
  status.textContent = state.midiStatus;
  status.classList.toggle('warn', !state.midi || !midiPorts().length);
}

function renderLoadZone() {
  const box = $('loadChips');
  box.innerHTML = '';
  state.arr.load.slice().sort((a, b) => a.ord - b.ord).forEach((ev) => box.append(chipEl(ev, '')));
  if (!state.arr.load.length) box.append(el('span', 'hint', 'Nothing sent when the song appears.'));
}

function renderNotice() {
  const notes = [];
  if (state.song.duplicates.length) {
    notes.push(`${state.song.duplicates.map((n) => `“${n}”`).join(', ')} appear${state.song.duplicates.length === 1 ? 's' : ''} more than once in the song text, so a structure can't tell them apart. “Build structure from song” numbers them.`);
  }
  const renames = state.textEdits.get(state.songIndex)?.renames;
  if (renames) notes.push(`Song text renamed: ${renameSummary(renames)}.`);
  if (!state.song.hasStructure) notes.push('This song has no structure in the file yet. The chart sections are shown in order as a starting point.');
  if (state.arr.trailing.length) notes.push(`${plural(state.arr.trailing.length, 'MIDI row')} sit after the last section and never fire. They are kept as they are.`);
  const missing = state.arr.steps.filter((s) => s.kind === 'section' && !state.song.chart.has(s.name)).map((s) => s.name);
  if (missing.length) notes.push(`Not found in the chart: ${[...new Set(missing)].join(', ')}.`);
  const notice = $('notice');
  notice.hidden = !notes.length;
  notice.textContent = notes.join(' ');
}

function renderTrack() {
  const track = $('track');
  track.innerHTML = '';
  const bpb = state.song.beatsPerBar;

  state.arr.steps.forEach((step, i) => {
    const L = state.layout[i];
    const row = el('div', 'step');
    row.dataset.uid = step.uid;
    row.dataset.kind = step.kind;
    row.style.height = L.h + 'px';

    const ruler = el('div', 'ruler');
    const block = el('div', 'block');
    const lane = el('div', 'lane');
    row.append(ruler, block, lane);

    if (step.kind === 'raw') {
      block.style.setProperty('--sec', '#c7c7cc');
      const head = el('div', 'block-head');
      head.append(el('span', 'lyric', `Kept as is: ${step.raw.type || 'unknown'} item`));
      block.append(head);
      track.append(row);
      return;
    }

    const sec = state.song.chart.get(step.name);
    block.style.setProperty('--sec', sec?.color || '#8e8e93');
    if (step.uid === state.tappedUid) block.classList.add('tapped');
    if (!sec) block.classList.add('missing');
    else if (!L.beats) block.classList.add('no-beats');

    for (let b = 0; b < L.beats; b += 1) {
      if ((L.start + b) % bpb !== 0) continue;
      const y = beatY(L, b);
      const line = el('div', 'bar-line downbeat');
      line.style.top = y + 'px';
      block.append(line);
      const no = el('span', 'bar-no', String((L.start + b) / bpb + 1));
      no.style.top = Math.max(y, 7) + 'px';
      ruler.append(no);
    }

    const head = el('div', 'block-head');
    const pill = sectionPill(step.name, true);
    pill.title = 'Click to tap this section (sends its selection presets) · drag to move it';
    pill.style.cursor = 'pointer';
    pill.addEventListener('dragstart', (e) => startDrag(e, { kind: 'step', uid: step.uid }));
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      tapSection(step);
    });
    head.append(pill);
    if (sec) {
      const edit = el('button', 'btn edit-section');
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/></svg>';
      edit.setAttribute('aria-label', `Edit section ${step.name}`);
      edit.disabled = state.song.duplicates.includes(step.name);
      edit.title = edit.disabled
        ? 'Use Build structure from song to number duplicate labels before editing this section'
        : 'Edit section · text, chords and {chordbeats: …}';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openSectionEditor(step.name); });
      block.append(edit);
    }
    block.append(head);

    renderChords(block, sec, L);
    renderLyrics(block, sec, L);

    const foot = el('div', 'block-foot');
    if (!sec) foot.textContent = 'not in chart';
    else if (!L.beats) foot.textContent = 'no chord beats · Edit section to add timing';
    else foot.textContent = `${L.beats} beats${L.beats % bpb === 0 ? ` · ${L.beats / bpb} bars` : ''}${sec.usesDefaultBeats ? ` · default: ${DEFAULT_CHORD_BEATS} per chord` : ''}`;
    block.append(foot);

    renderLane(lane, step, L);
    track.append(row);
  });

  if (!state.arr.steps.length) {
    track.append(el('div', 'notice', 'Empty structure. Click or drag a section from the top to start.'));
  }
  if (state.play) track.append(state.play.playhead);
}

function chordLabel(chord) {
  const span = el('span', '', chord.symbol);
  if (chord.beats) {
    span.append(el('span', 'dots', chord.beats > 8 ? `${chord.beats}•` : '•'.repeat(chord.beats)));
  }
  return span;
}

function renderChords(block, sec, L) {
  if (!sec || !sec.chords.length) return;
  if (!L.beats) {
    const row = el('div', 'chord-row');
    row.style.top = '14px';
    sec.chords.forEach((c) => row.append(chordLabel(c)));
    block.append(row);
    return;
  }
  let row = null;
  let rowY = -Infinity;
  for (const chord of sec.chords) {
    const y = beatY(L, chord.at);
    if (!row || y - rowY >= 18) {
      row = el('div', 'chord-row');
      rowY = y;
      row.style.top = Math.max(y + 6, 6) + 'px';
      block.append(row);
    }
    row.append(chordLabel(chord));
  }
}

function renderLyrics(block, sec, L) {
  for (const line of sec?.lyrics || []) {
    const row = el('div', 'lyric-row', line.text);
    row.style.top = beatY(L, line.at) + 6 + 'px';
    block.append(row);
  }
}

function renderLane(lane, step, L) {
  const placed = L.groups.map((g) => {
    const y = beatY(L, eventOffsetBeat(L, g.trigger, g.delay), g.trigger);
    return { ...g, y, top: g.trigger === 'select' ? y + 1 : y - GROUP_HEIGHT - 1 };
  }).sort((a, b) => a.top - b.top);

  for (let i = 0; i < placed.length; i += 1) {
    placed[i].top = Math.max(placed[i].top, 0, i ? placed[i - 1].top + GROUP_HEIGHT + 2 : 0);
  }
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const limit = i === placed.length - 1 ? L.h - GROUP_HEIGHT : placed[i + 1].top - GROUP_HEIGHT - 2;
    placed[i].top = Math.max(0, Math.min(placed[i].top, limit));
  }

  for (const g of placed) {
    const tick = el('div', 'tick ' + g.trigger);
    tick.style.top = Math.min(Math.max(g.y, 1), L.h - 1) + 'px';
    lane.append(tick);

    const group = el('div', 'group');
    group.style.top = g.top + 'px';
    g.events.slice().sort((a, b) => a.ord - b.ord).forEach((ev) => group.append(chipEl(ev, step.name)));
    lane.append(group);
  }
}

function libraryGroups() {
  const title = norm(state.song.title);
  const chartOrder = [...state.song.chart.keys()].map(norm);
  const song = { id: 'song', title: `This song · ${state.song.title}`, items: [] };
  const labels = new Map();

  for (const preset of state.presets.values()) {
    const label = presetLabel(preset.name);
    const parts = songPresetParts(preset.name);
    if (parts && norm(parts.song) === title) {
      song.items.push(preset);
      continue;
    }
    if (!labels.has(label.id)) labels.set(label.id, { ...label, items: [] });
    labels.get(label.id).items.push(preset);
  }

  const songRank = (preset) => {
    const part = norm(songPresetParts(preset.name)?.part);
    if (part.startsWith('song load')) return -1;
    const idx = chartOrder.findIndex((n) => part.startsWith(n + ' ') || part === n);
    return idx < 0 ? 999 : idx;
  };
  song.items.sort((a, b) => songRank(a) - songRank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const groups = [...labels.values()].sort((a, b) => norm(a.title).localeCompare(norm(b.title), undefined, { numeric: true }));
  for (const group of groups) {
    if (group.items.every((p) => songPresetParts(p.name))) group.title += ' · other songs';
    group.items.sort((a, b) => norm(a.name).localeCompare(norm(b.name), undefined, { numeric: true }));
  }
  return [song, ...groups];
}

/* ---------------- preset editor ---------------- */

const MESSAGE_TYPES = [
  [0xc0, 'Program Change', 'Program', null],
  [0xb0, 'Control Change', 'Controller', 'Value'],
  [0x90, 'Note On', 'Note', 'Velocity'],
  [0x80, 'Note Off', 'Note', 'Velocity'],
  [0xe0, 'Pitch Bend', 'LSB', 'MSB'],
  [0xd0, 'Channel Pressure', 'Pressure', null],
  [0xa0, 'Poly Pressure', 'Note', 'Pressure'],
];
let editingPreset = null;

function openPresetEditor(id) {
  if (!state.library) return;
  editingPreset = id ? structuredClone(state.presetEdits.get(id)
    || state.library.midiLibraryMessages.find((p) => p.id === id)) : null;
  $('presetDialogTitle').textContent = id ? 'Edit MIDI preset' : 'New MIDI preset';
  $('presetHelp').textContent = id
    ? 'Changes apply wherever this preset is used in the library.'
    : 'Create a reusable preset, then drag it from the library onto the timeline.';
  $('presetName').value = editingPreset?.name || '';
  $('presetError').hidden = true;
  $('presetMessages').replaceChildren();
  const messages = editingPreset?.midi.length ? editingPreset.midi : [{ status: 0xc0, channel: 0, data1: 0, data2: 0 }];
  messages.forEach(addPresetMessage);
  $('presetDialog').showModal();
  $('presetName').focus();
}

function updateMessageOrder() {
  const rows = [...$('presetMessages').children];
  rows.forEach((row, i) => {
    row.querySelector('legend').textContent = `Message ${i + 1}`;
    row.querySelector('[data-move="up"]').disabled = i === 0;
    row.querySelector('[data-move="down"]').disabled = i === rows.length - 1;
    row.querySelector('[data-remove]').disabled = rows.length === 1;
  });
}

function addPresetMessage(message = { status: 0xc0, channel: 0, data1: 0, data2: 0 }) {
  const row = el('fieldset', 'message-row');
  row.messageSource = structuredClone(message);
  row.append(el('legend'));
  const fields = el('div', 'message-fields');
  const typeLabel = el('label', '', 'Type');
  const type = el('select');
  type.setAttribute('aria-label', 'Type');
  type.dataset.field = 'status';
  const types = [...MESSAGE_TYPES];
  if (!types.some(([value]) => value === message.status)) {
    types.push([message.status, `Status ${message.status}`, 'Data 1', 'Data 2']);
  }
  for (const [value, title] of types) {
    const option = el('option', '', title);
    option.value = value;
    type.append(option);
  }
  type.value = message.status;
  typeLabel.append(type);
  fields.append(typeLabel);
  const numberField = (name, title, value, min, max) => {
    const label = el('label');
    const caption = el('span', '', title);
    const input = el('input');
    input.type = 'number';
    input.dataset.field = name;
    input.min = min;
    input.max = max;
    input.step = 1;
    input.required = true;
    input.value = value;
    label.append(caption, input);
    fields.append(label);
    return { caption, input, label };
  };
  numberField('channel', 'Channel', Number(message.channel ?? 0) + 1, 1, 16);
  const data1 = numberField('data1', '', message.data1 ?? 0, 0, 127);
  const data2 = numberField('data2', '', message.data2 ?? 0, 0, 127);
  const updateType = () => {
    const definition = types.find(([value]) => value === Number(type.value));
    data1.caption.textContent = definition[2];
    data2.caption.textContent = definition[3] || 'Unused';
    data2.input.disabled = !definition[3];
  };
  type.addEventListener('change', updateType);
  updateType();
  row.append(fields);
  const actions = el('div', 'message-actions');
  for (const [direction, title] of [['up', 'Move up'], ['down', 'Move down']]) {
    const button = el('button', 'btn btn-small', title);
    button.type = 'button';
    button.dataset.move = direction;
    button.addEventListener('click', () => {
      if (direction === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
      if (direction === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
      updateMessageOrder();
      row.querySelector('select').focus();
    });
    actions.append(button);
  }
  const remove = el('button', 'btn btn-small btn-danger', 'Remove message');
  remove.type = 'button';
  remove.dataset.remove = '';
  remove.addEventListener('click', () => {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    updateMessageOrder();
    next?.querySelector('select').focus();
  });
  actions.append(remove);
  row.append(actions);
  $('presetMessages').append(row);
  updateMessageOrder();
}

function savePreset(e) {
  e.preventDefault();
  const name = $('presetName').value.trim();
  if (!name) {
    $('presetError').textContent = 'Enter a preset name.';
    $('presetError').hidden = false;
    $('presetName').focus();
    return;
  }
  if (!$('presetForm').reportValidity()) return;
  const midi = [...$('presetMessages').children].map((row) => {
    const value = (field) => Number(row.querySelector(`[data-field="${field}"]`).value);
    const message = { ...row.messageSource };
    const values = { status: value('status'), channel: value('channel') - 1, data1: value('data1'), data2: value('data2') };
    for (const [field, number] of Object.entries(values)) {
      // Preserve absent optional fields when their displayed default is unchanged.
      if (field in message || number !== 0) message[field] = number;
    }
    return message;
  });
  const preset = { ...(editingPreset || { id: crypto.randomUUID().toUpperCase(), date: Date.now() / 1000 - 978307200 }), name, midi };
  const original = state.library.midiLibraryMessages?.find((p) => p.id === preset.id);
  if (original && canonical(original) === canonical(preset)) state.presetEdits.delete(preset.id);
  else state.presetEdits.set(preset.id, preset);
  stopPlayback();
  state.presets.set(preset.id, { ...preset });
  const names = new Map();
  for (const p of state.presets.values()) names.set(p.name, (names.get(p.name) || 0) + 1);
  for (const p of state.presets.values()) p.duplicate = names.get(p.name) > 1;
  state.query = '';
  $('search').value = '';
  // Open the preset's group even if its name moves it to a different group.
  const group = libraryGroups().find((g) => g.items.some((p) => p.id === preset.id));
  if (group) state.openGroups.add(group.id);
  $('presetDialog').close();
  render();
  [...$('libraryList').querySelectorAll('.preset')].find((row) => row.dataset.presetId === preset.id)?.scrollIntoView({ block: 'nearest' });
  showSaveStatus(`Saved “${name}” with ${plural(midi.length, 'MIDI message')}. Download an edited copy to keep your changes.`, true);
}

function renderLibrary() {
  const list = $('libraryList');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const counts = usageCounts();
  const q = norm(state.query);

  for (const group of libraryGroups()) {
    const items = q ? group.items.filter((p) => norm(p.name + ' ' + describeMessages(p.midi)).includes(q)) : group.items;
    if (!items.length) continue;

    const details = el('details', 'lib-group');
    details.open = !!q || state.openGroups.has(group.id);
    details.addEventListener('toggle', () => {
      if (q) return;
      if (details.open) state.openGroups.add(group.id);
      else state.openGroups.delete(group.id);
    });
    const summary = el('summary', '', group.title);
    summary.append(el('span', 'count', String(items.length)));
    details.append(summary);

    for (const preset of items) {
      const row = el('div', 'preset');
      row.dataset.presetId = preset.id;
      row.draggable = true;
      row.title = `${preset.name}\nDrag onto the timeline`;
      const dot = el('span', 'dot');
      dot.style.background = presetColor(preset);
      const text = el('div', 'preset-text');
      text.append(
        el('div', 'preset-name', group.id === 'song' ? shortName(preset) : preset.name),
        el('div', 'preset-bytes', describeMessages(preset.midi) + (preset.duplicate ? ' · duplicate name' : '')),
      );
      row.append(dot, text);
      if (counts.get(preset.id)) row.append(el('span', 'used', `×${counts.get(preset.id)}`));
      const send = el('button', 'send', 'Send');
      send.title = 'Send this preset now';
      send.draggable = false;
      send.addEventListener('click', (e) => {
        e.stopPropagation();
        sendPresetNow(preset, 'Test');
      });
      const edit = el('button', 'send edit-preset', 'Edit');
      edit.title = `Edit ${preset.name}`;
      edit.draggable = false;
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openPresetEditor(preset.id);
      });
      row.append(edit, send);
      for (const button of [edit, send]) button.addEventListener('dragstart', (e) => e.preventDefault());
      row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'preset', midiRef: preset.id }));
      details.append(row);
    }
    list.append(details);
  }
  list.scrollTop = scroll;
}

function renderInspector() {
  const box = $('inspector');
  const found = state.selectedUid && findEvent(state.selectedUid);
  if (!found) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '';

  const { ev, step } = found;
  const preset = state.presets.get(ev.midiRef);
  const sections = state.arr.steps.filter((s) => s.kind === 'section');

  box.append(
    el('div', 'insp-name', preset ? preset.name : `Missing preset ${ev.midiRef}`),
    el('div', 'insp-bytes', preset ? describeMessages(preset.midi) : ''),
  );

  const whenRow = el('div', 'insp-row');
  whenRow.append(el('label', '', 'Trigger'));
  const seg = el('div', 'segmented');
  for (const [trigger, label] of [['load', 'Song load'], ['select', 'Section start'], ['deselect', 'Section end']]) {
    const b = el('button', ev.trigger === trigger ? 'on' : '', label);
    b.disabled = trigger !== 'load' && !sections.length;
    b.addEventListener('click', () => mutate(() => {
      if (trigger === ev.trigger) return;
      const target = step || sections[0];
      detachEvent(ev.uid);
      placeEvent(ev, target, trigger, ev.delay);
    }));
    seg.append(b);
  }
  whenRow.append(seg);
  box.append(whenRow);

  if (ev.trigger !== 'load' && step) {
    const secRow = el('div', 'insp-row');
    secRow.append(el('label', '', 'Section'));
    const select = el('select');
    state.arr.steps.forEach((s, i) => {
      if (s.kind !== 'section') return;
      const option = el('option', '', `${i + 1} · ${s.name}`);
      option.value = s.uid;
      option.selected = s === step;
      select.append(option);
    });
    select.addEventListener('change', () => mutate(() => {
      const target = state.arr.steps.find((s) => s.uid === select.value);
      detachEvent(ev.uid);
      placeEvent(ev, target, ev.trigger, ev.delay);
    }));
    secRow.append(select);
    box.append(secRow);

    const delayRow = el('div', 'insp-row');
    delayRow.append(el('label', '', ev.trigger === 'select' ? 'Delay' : 'Anticipation'));
    const stepper = el('div', 'stepper');
    const minus = el('button', '', '−');
    const plus = el('button', '', '+');
    minus.disabled = ev.delay <= 0;
    plus.disabled = ev.delay >= MAX_DELAY;
    minus.addEventListener('click', () => mutate(() => { ev.delay -= 1; }));
    plus.addEventListener('click', () => mutate(() => { ev.delay += 1; }));
    stepper.append(minus, el('span', '', plural(ev.delay, 'beat')), plus);
    delayRow.append(stepper);
    box.append(delayRow);
  }

  let when = timingText(step?.name, ev.trigger, ev.delay);
  if (step) {
    const i = state.arr.steps.indexOf(step);
    const L = state.layout[i];
    when += ` → ${barBeat(L.start + eventOffsetBeat(L, ev.trigger, ev.delay))}`;
    if (!L.beats && ev.delay) when += ' (section has no chord beats, so the offset cannot be timed)';
    else if (ev.delay > L.beats) when += ` (offset is longer than the ${L.beats}-beat section)`;
  }
  box.append(el('div', 'insp-when', when));

  const actions = el('div', 'insp-actions');
  const del = el('button', 'btn btn-ghost btn-danger', 'Remove event');
  del.addEventListener('click', () => mutate(() => { detachEvent(ev.uid); state.selectedUid = null; }));
  const done = el('button', 'btn', 'Done');
  done.addEventListener('click', () => { state.selectedUid = null; render(); });
  const right = el('div');
  right.style.display = 'flex';
  right.style.gap = '6px';
  right.append(done);
  actions.append(del, right);
  box.append(actions);
}

/* ---------------- drag & drop ---------------- */

function startDrag(e, payload) {
  state.drag = payload;
  e.dataTransfer.effectAllowed = payload.kind === 'preset' || payload.kind === 'newStep' ? 'copy' : 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(payload));
}

function clearDragFeedback() {
  document.querySelectorAll('.guide, .insert-line').forEach((n) => n.remove());
  document.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
  state.drop = null;
}

function snapAt(step, L, relY) {
  if (!L.beats) {
    return relY < L.h / 2 ? { trigger: 'select', delay: 0 } : { trigger: 'deselect', delay: 0 };
  }
  const beat = Math.max(0, Math.min(L.beats, Math.round((relY / L.h) * L.beats)));
  return beat <= L.beats / 2 ? { trigger: 'select', delay: beat } : { trigger: 'deselect', delay: L.beats - beat };
}

function showGuide(row, step, L, snap) {
  const track = $('track');
  let guide = track.querySelector('.guide');
  if (!guide) {
    guide = el('div', 'guide');
    guide.append(el('span', 'guide-label'));
    track.append(guide);
  }
  const y = beatY(L, eventOffsetBeat(L, snap.trigger, snap.delay), snap.trigger);
  guide.className = 'guide ' + snap.trigger;
  guide.style.top = row.offsetTop + y + 'px';
  guide.firstChild.textContent = `${timingText(step.name, snap.trigger, snap.delay)} · ${barBeat(L.start + eventOffsetBeat(L, snap.trigger, snap.delay))}`;
}

function insertionIndex(clientY) {
  const rows = [...$('track').querySelectorAll('.step')];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function showInsertLine(index) {
  const track = $('track');
  let line = track.querySelector('.insert-line');
  if (!line) {
    line = el('div', 'insert-line');
    track.append(line);
  }
  const rows = track.querySelectorAll('.step');
  const top = index < rows.length ? rows[index].offsetTop - 2 : track.scrollHeight;
  line.style.top = top + 'px';
}

function onTrackDragOver(e) {
  const d = state.drag;
  if (!d) return;

  if (d.kind === 'preset' || d.kind === 'event') {
    const row = e.target.closest('.step');
    const step = row && state.arr.steps.find((s) => s.uid === row.dataset.uid);
    if (!step || step.kind !== 'section') { clearDragFeedback(); return; }
    e.preventDefault();
    const L = state.layout[state.arr.steps.indexOf(step)];
    const snap = snapAt(step, L, e.clientY - row.getBoundingClientRect().top);
    state.drop = { step, snap };
    showGuide(row, step, L, snap);
  } else {
    e.preventDefault();
    const index = insertionIndex(e.clientY);
    state.drop = { index };
    showInsertLine(index);
  }
}

function moveStepTo(d, index) {
  if (d.kind === 'newStep') {
    state.arr.steps.splice(index, 0, { uid: uid(), kind: 'section', name: d.name, select: [], deselect: [], raw: {} });
    return;
  }
  const from = state.arr.steps.findIndex((s) => s.uid === d.uid);
  if (from < 0) return;
  const [step] = state.arr.steps.splice(from, 1);
  state.arr.steps.splice(from < index ? index - 1 : index, 0, step);
}

function onTrackDrop(e) {
  const d = state.drag;
  const drop = state.drop;
  if (!d || !drop) return;
  e.preventDefault();
  clearDragFeedback();
  mutate(() => {
    if (d.kind === 'preset' || d.kind === 'event') {
      const ev = d.kind === 'preset' ? newEvent(d.midiRef) : detachEvent(d.uid);
      if (!ev) return;
      placeEvent(ev, drop.step, drop.snap.trigger, drop.snap.delay);
      state.selectedUid = ev.uid;
    } else {
      moveStepTo(d, drop.index);
    }
  });
}

function bindDropZones() {
  const track = $('track');
  track.addEventListener('dragover', onTrackDragOver);
  track.addEventListener('drop', onTrackDrop);
  track.addEventListener('dragleave', (e) => {
    if (!track.contains(e.relatedTarget)) clearDragFeedback();
  });

  const load = $('loadZone');
  load.addEventListener('dragover', (e) => {
    if (state.drag?.kind !== 'preset' && state.drag?.kind !== 'event') return;
    e.preventDefault();
    load.classList.add('drag-over');
  });
  load.addEventListener('dragleave', (e) => { if (!load.contains(e.relatedTarget)) load.classList.remove('drag-over'); });
  load.addEventListener('drop', (e) => {
    const d = state.drag;
    if (!d) return;
    e.preventDefault();
    clearDragFeedback();
    mutate(() => {
      const ev = d.kind === 'preset' ? newEvent(d.midiRef) : detachEvent(d.uid);
      if (!ev) return;
      placeEvent(ev, null, 'load', 0);
      state.selectedUid = ev.uid;
    });
  });

  const end = $('endZone');
  end.addEventListener('dragover', (e) => {
    if (state.drag?.kind !== 'step' && state.drag?.kind !== 'newStep') return;
    e.preventDefault();
    end.classList.add('drag-over');
  });
  end.addEventListener('dragleave', () => end.classList.remove('drag-over'));
  end.addEventListener('drop', (e) => {
    const d = state.drag;
    if (!d) return;
    e.preventDefault();
    clearDragFeedback();
    mutate(() => moveStepTo(d, state.arr.steps.length));
  });

  const library = document.querySelector('.library');
  library.addEventListener('dragover', (e) => {
    if (state.drag?.kind === 'event') e.preventDefault();
  });
  library.addEventListener('drop', (e) => {
    if (state.drag?.kind !== 'event') return;
    e.preventDefault();
    const id = state.drag.uid;
    mutate(() => { detachEvent(id); if (state.selectedUid === id) state.selectedUid = null; });
  });

  document.addEventListener('dragend', () => {
    state.drag = null;
    clearDragFeedback();
  });
}

/* ---------------- MIDI output ---------------- */

const byOrd = (a, b) => a.ord - b.ord;

function midiPorts() {
  if (!state.midi) return [];
  const outputs = [...state.midi.outputs.values()].filter((o) => o.state !== 'disconnected');
  return settings.midiOut === 'all' ? outputs : outputs.filter((o) => o.id === settings.midiOut);
}

function portLabel() {
  if (!state.midi) return 'no MIDI';
  const ports = midiPorts();
  if (settings.midiOut === 'all') return ports.length ? 'all' : 'no outputs';
  return ports[0]?.name || 'disconnected';
}

function sendBytes(bytes, time) {
  for (const port of midiPorts()) {
    try {
      port.send(bytes, time);
    } catch (err) {
      console.warn('MIDI send failed', port.name, bytes, err);
    }
  }
  if (state.play) state.play.lastTime = Math.max(state.play.lastTime, time);
}

function refreshOutputs() {
  const select = $('midiOut');
  select.innerHTML = '';
  const all = el('option', '', 'All outputs (like JustChords)');
  all.value = 'all';
  select.append(all);

  const outputs = state.midi ? [...state.midi.outputs.values()] : [];
  for (const o of outputs) {
    const option = el('option', '', o.name + (o.state === 'disconnected' ? ' (disconnected)' : ''));
    option.value = o.id;
    select.append(option);
  }
  if (settings.midiOut !== 'all' && !outputs.some((o) => o.id === settings.midiOut)) {
    const option = el('option', '', 'Saved output (not connected)');
    option.value = settings.midiOut;
    select.append(option);
  }
  select.value = settings.midiOut;
  select.disabled = !state.midi;

  if (state.midi) {
    const connected = outputs.filter((o) => o.state !== 'disconnected');
    state.midiStatus = connected.length
      ? `MIDI ready · ${plural(connected.length, 'output')}: ${connected.map((o) => o.name).join(', ')}`
      : 'No MIDI outputs found. Connect a device, or enable the IAC Driver in Audio MIDI Setup.';
  }
  renderTransport();
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    state.midi = null;
    state.midiStatus = 'This browser has no Web MIDI (Safari). Open the page in Chrome or Edge to send MIDI; editing still works here.';
  } else {
    try {
      state.midi = await navigator.requestMIDIAccess({ sysex: false });
      state.midi.addEventListener('statechange', refreshOutputs);
    } catch (err) {
      state.midi = null;
      state.midiStatus = `MIDI access was refused (${err.name}). Use Chrome or Edge and allow MIDI for this page, then reload.`;
    }
  }
  refreshOutputs();
}

const posLabel = (beat) => barBeat(beat).replace('bar ', 'b').replace(' · beat ', '.');

function logLine(moment, where, text) {
  const log = $('midiLog');
  log.hidden = false;
  const line = el('div');
  line.append(el('span', 'm ' + moment, moment), el('span', 't', String(where || '').padEnd(7)), el('span', '', text));
  log.append(line);
  while (log.children.length > 12) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function presetLines(preset) {
  return preset.midi.map((m) => `${messageBody(m)} · ch ${midiChannel(m)} → ${portLabel()} · ${shortName(preset)}`);
}

function flashChip(evUid) {
  const chip = document.querySelector(`.chip[data-uid="${evUid}"]`);
  if (!chip) return;
  chip.classList.remove('fired');
  void chip.offsetWidth;
  chip.classList.add('fired');
}

function sendPresetNow(preset, moment, where = '', evUid = null) {
  if (!preset) return;
  const now = performance.now();
  preset.midi.forEach((m) => sendBytes(messageBytes(m), now));
  presetLines(preset).forEach((text) => logLine(moment, where, text));
  if (evUid) flashChip(evUid);
}

function sendDisplayPresets() {
  const events = state.arr.load.slice().sort(byOrd);
  events.forEach((ev) => sendPresetNow(state.presets.get(ev.midiRef), 'Display', '', ev.uid));
  if (!events.length) logLine('Display', '', 'This song has no Song Appear presets');
}

function displaySong() {
  stopPlayback();
  state.displayed = true;
  state.tappedUid = null;
  render();
  sendDisplayPresets();
}

function tapSection(step) {
  if (state.play) return;
  const previous = state.arr.steps.find((s) => s.uid === state.tappedUid);
  const needsDisplay = !state.displayed;
  state.displayed = true;
  state.tappedUid = step.uid;
  render();
  if (needsDisplay) sendDisplayPresets();
  if (previous) {
    previous.deselect.slice().sort(byOrd).forEach((ev) => sendPresetNow(state.presets.get(ev.midiRef), 'Tap', 'out', ev.uid));
  }
  step.select.slice().sort(byOrd).forEach((ev) => sendPresetNow(state.presets.get(ev.midiRef), 'Tap', 'in', ev.uid));
  if (!step.select.length && !previous?.deselect.length) logLine('Tap', '', `${step.name}: no selection presets`);
}

function panic() {
  stopPlayback();
  const now = performance.now();
  for (let ch = 0; ch < 16; ch += 1) sendBytes([0xb0 | ch, 123, 0], now);
  logLine('Panic', '', `CC123=0 (All Notes Off) · ch 1–16 → ${portLabel()}`);
}

/* ---------------- scheduled playback ---------------- */

function buildSchedule() {
  const items = [];
  state.arr.steps.forEach((step, i) => {
    const L = state.layout[i];
    for (const ev of [...step.select, ...step.deselect]) {
      items.push({ beat: L.start + eventOffsetBeat(L, ev.trigger, ev.delay), prio: 1, ord: ev.ord, kind: 'preset', ev });
    }
    if (!settings.chords || step.kind !== 'section') return;
    for (const chord of state.song.chart.get(step.name)?.chords || []) {
      if (!chord.beats) continue;
      const notes = chordNotes(chord.symbol);
      if (!notes) {
        items.push({ beat: L.start + chord.at, prio: 2, ord: 0, kind: 'silent', chord });
        continue;
      }
      items.push({ beat: L.start + chord.at, prio: 2, ord: 0, kind: 'on', notes, chord });
      items.push({ beat: L.start + chord.at + chord.beats, prio: 0, ord: 0, kind: 'off', notes, chord });
    }
  });
  return items.sort((a, b) => a.beat - b.beat || a.prio - b.prio || a.ord - b.ord);
}

function startPlayback() {
  if (!state.arr.steps.length) return;
  const needsDisplay = !state.displayed;
  state.displayed = true;
  state.tappedUid = null;
  render();
  if (needsDisplay) sendDisplayPresets();

  const msPerBeat = 60000 / state.song.bpm;
  const clockStart = performance.now() + START_LEAD_MS;
  const countBeats = settings.countIn * state.song.beatsPerBar;
  const t0 = clockStart + countBeats * msPerBeat;
  const playhead = el('div', 'playhead');
  $('track').append(playhead);
  state.play = {
    t0, msPerBeat, items: buildSchedule(), next: 0, visual: [], sounding: new Set(),
    clock: settings.clock, nextClock: clockStart, lastTime: clockStart, playhead, raf: 0, timer: 0,
  };
  if (state.play.clock) {
    sendBytes([0xfa], clockStart);
    const countText = countBeats ? ` · count-in ${plural(settings.countIn, 'bar')}` : '';
    state.play.visual.push({ time: clockStart, fn: () => logLine('Play', '', `Clock Start · 24 ppq at ${state.song.bpm} bpm${countText} → ${portLabel()}`) });
  }
  for (let b = 0; b < countBeats; b += 1) {
    const bar = Math.floor(b / state.song.beatsPerBar) + 1;
    const text = `${b % state.song.beatsPerBar + 1}${settings.countIn > 1 ? ` (bar ${bar} of ${settings.countIn})` : ''}`;
    state.play.visual.push({ time: clockStart + b * msPerBeat, fn: () => logLine('Count', '', text) });
  }
  state.play.timer = setInterval(scheduleAhead, TICK_MS);
  scheduleAhead();
  $('playBtn').textContent = '■';
  $('playBtn').classList.add('playing');
  state.play.raf = requestAnimationFrame(tick);
}

function scheduleAhead() {
  const p = state.play;
  if (!p) return;
  const horizon = performance.now() + LOOKAHEAD_MS;
  while (p.next < p.items.length) {
    const item = p.items[p.next];
    const time = p.t0 + item.beat * p.msPerBeat;
    if (time > horizon) break;
    dispatchItem(item, time);
    p.next += 1;
  }
  if (p.clock) {
    while (p.nextClock <= horizon) {
      sendBytes([0xf8], p.nextClock);
      p.nextClock += p.msPerBeat / 24;
    }
  }
}

function dispatchItem(item, time) {
  const p = state.play;
  const where = posLabel(item.beat);
  const status = (type) => type | (CHORD_CHANNEL - 1);

  if (item.kind === 'preset') {
    const preset = state.presets.get(item.ev.midiRef);
    if (!preset) return;
    preset.midi.forEach((m) => sendBytes(messageBytes(m), time));
    const lines = presetLines(preset);
    p.visual.push({ time, fn: () => { lines.forEach((text) => logLine('Play', where, text)); flashChip(item.ev.uid); } });
  } else if (item.kind === 'on') {
    const velocity = Math.max(1, Math.min(127, settings.velocity));
    item.notes.forEach((n) => { sendBytes([status(0x90), n, velocity], time); p.sounding.add(n); });
    const text = `Note On ${item.chord.symbol} (${item.notes.map(noteName).join(' ')}) · ch ${CHORD_CHANNEL} → ${portLabel()}`;
    p.visual.push({ time, fn: () => logLine('Play', where, text) });
  } else if (item.kind === 'silent') {
    sendBytes([status(0xb0), 123, 0], time);
    const text = `CC123=0 (All Notes Off) for ${item.chord.symbol} · ch ${CHORD_CHANNEL} → ${portLabel()}`;
    p.visual.push({ time, fn: () => logLine('Play', where, text) });
  } else {
    const velocity = Math.max(1, Math.min(127, settings.velocity));
    item.notes.forEach((n) => { sendBytes([status(0x80), n, velocity], time); p.sounding.delete(n); });
  }
}

function stopPlayback() {
  const p = state.play;
  if (!p) return;
  clearInterval(p.timer);
  cancelAnimationFrame(p.raf);
  p.visual.splice(0).forEach((v) => v.fn());

  const time = Math.max(performance.now(), p.lastTime + 1);
  const released = p.sounding.size;
  for (const n of p.sounding) sendBytes([0x80 | (CHORD_CHANNEL - 1), n, 0], time);
  sendBytes([0xb0 | (CHORD_CHANNEL - 1), 123, 0], time);
  if (p.clock) sendBytes([0xfc], time);

  p.playhead.remove();
  state.play = null;
  logLine('Stop', '', `${released ? `Note Off ×${released} · ` : ''}CC123=0 (All Notes Off) · ch ${CHORD_CHANNEL}${p.clock ? ' · Clock Stop' : ''} → ${portLabel()}`);
  $('playBtn').textContent = '▶';
  $('playBtn').classList.remove('playing');
}

function playheadY(beat) {
  const rows = $('track').querySelectorAll('.step');
  const b = Math.max(beat, 0);
  for (let i = 0; i < state.layout.length; i += 1) {
    const L = state.layout[i];
    if (L.beats && b >= L.start && b < L.start + L.beats) return rows[i].offsetTop + beatY(L, b - L.start);
  }
  const last = rows[rows.length - 1];
  return last ? last.offsetTop + last.offsetHeight : 0;
}

function tick() {
  const p = state.play;
  if (!p) return;
  const now = performance.now();
  while (p.visual.length && p.visual[0].time <= now) p.visual.shift().fn();

  const beat = (now - p.t0) / p.msPerBeat;
  const track = $('track');
  const y = playheadY(beat);
  p.playhead.style.top = y + 'px';

  const pane = $('leftPane');
  const yInPane = track.offsetTop + y;
  if (yInPane < pane.scrollTop + pane.clientHeight * 0.15 || yInPane > pane.scrollTop + pane.clientHeight * 0.65) {
    pane.scrollTop = yInPane - pane.clientHeight * 0.3;
  }

  if (p.next >= p.items.length && beat > state.totalBeats + 0.5) {
    stopPlayback();
    return;
  }
  p.raf = requestAnimationFrame(tick);
}

/* ---------------- boot ---------------- */

function bindUi() {
  $('songSelect').addEventListener('change', (e) => openSong(Number(e.target.value)));
  $('zoom').addEventListener('input', (e) => { state.ppb = Number(e.target.value); stopPlayback(); render(); });
  $('playBtn').addEventListener('click', () => (state.play ? stopPlayback() : startPlayback()));
  $('displayBtn').addEventListener('click', displaySong);
  $('panicBtn').addEventListener('click', panic);

  $('midiOut').addEventListener('change', (e) => { saveSetting('midiOut', e.target.value); refreshOutputs(); });
  $('chordsOn').checked = settings.chords;
  $('chordsOn').addEventListener('change', (e) => { stopPlayback(); saveSetting('chords', e.target.checked); });
  $('velocity').value = settings.velocity;
  $('velocity').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(127, Math.round(Number(e.target.value)) || 90));
    e.target.value = v;
    saveSetting('velocity', v);
  });
  $('clockOn').checked = settings.clock;
  $('clockOn').addEventListener('change', (e) => { stopPlayback(); saveSetting('clock', e.target.checked); });
  $('countIn').value = String(settings.countIn);
  $('countIn').addEventListener('change', (e) => { stopPlayback(); saveSetting('countIn', Number(e.target.value)); });

  $('revertBtn').addEventListener('click', revertSong);
  $('downloadBtn').addEventListener('click', downloadLibrary);
  $('buildBtn').addEventListener('click', buildStructureFromSong);
  $('fillSongBeatsBtn').addEventListener('click', fillSongChordBeats);
  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });
  $('newPresetBtn').addEventListener('click', () => openPresetEditor());
  $('addMessageBtn').addEventListener('click', () => {
    addPresetMessage();
    $('presetMessages').lastElementChild.querySelector('select').focus();
  });
  $('cancelPresetBtn').addEventListener('click', () => $('presetDialog').close());
  $('presetForm').addEventListener('submit', savePreset);
  $('presetName').addEventListener('input', () => { $('presetError').hidden = true; });
  $('sectionForm').addEventListener('submit', saveSectionText);
  $('sectionText').addEventListener('input', updateSectionTiming);
  $('setDefaultBeatsBtn').addEventListener('click', setDefaultChordBeats);
  $('cancelSectionBtn').addEventListener('click', () => $('sectionDialog').close());
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      loadLibrary(JSON.parse(await file.text()), file.name);
      showSaveStatus(`Opened ${file.name} in your browser. Your original JSON is read-only; download an edited copy when ready.`, true);
    } catch (err) {
      alert(`Could not read ${file.name}: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    if (e.key === ' ') {
      e.preventDefault();
      state.play ? stopPlayback() : startPlayback();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedUid) {
      e.preventDefault();
      mutate(() => { detachEvent(state.selectedUid); state.selectedUid = null; });
    } else if (e.key === 'Escape' && state.selectedUid) {
      state.selectedUid = null;
      render();
    }
  });

  $('leftPane').addEventListener('click', (e) => {
    if (state.selectedUid && !e.target.closest('.chip')) {
      state.selectedUid = null;
      render();
    }
  });

  bindDropZones();
}

bindUi();
initMidi();
async function loadInitialLibrary() {
  try {
    const response = await fetch('demo-library.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    loadLibrary(await response.json(), 'demo-library.json');
    showSaveStatus('Demo songs. Open your library.json to get started. Your file stays on your device; download creates a separate edited copy.', true);
  } catch (err) {
    $('notice').hidden = false;
    $('notice').textContent = `Could not load the library (${err.message}). Use “Open library.json…” to choose your file.`;
  }
}

loadInitialLibrary();

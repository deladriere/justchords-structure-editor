'use strict';

// Pure repair planning: the caller decides when to apply a reviewed plan.
const LibraryCheck = (() => {
  const musical = /^(?:intro|outro|verse|chorus|pre[- ]?chorus|bridge|solo|instrumental|interlude|refrain|couplet|pont|break|ending|end|coda|final|drum|synth solo|piano solo|introdução|primeira parte|segunda parte|terceira parte)(?:[\s_]*\d+)?(?:\s*[-–—/]\s*.+)?$/i;
  const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const key = (value) => tidy(value).toLowerCase();

  function candidate(line) {
    const text = line.trim();
    const existing = labelOf(line);
    if (existing && !/[|]|https?:\/\//i.test(text)) {
      return { name: text.replace(/[:：\s]+$/, ''), oldName: existing, rest: '', from: text };
    }
    let match = text.match(/^([^:]+):+\s*(.+)$/);
    if (match && musical.test(tidy(match[1]))) return { name: match[1], oldName: null, rest: match[2].trim(), from: text };
    match = text.match(/^\[(.+?)\](.*)$/);
    if (match && musical.test(tidy(match[1]))) return { name: match[1], oldName: null, rest: match[2].trim(), from: text };
    match = text.match(/^\{\s*(?:comment|c)\s*:\s*([^}]+)\}\s*$/i)
      || text.match(/^\{\s*([^}:]+)\s*\}\s*$/)
      || text.match(/^[('"“‘]\s*(.+?)\s*[)'"”’]?\s*$/);
    const name = (match ? match[1] : text).replace(/[:：.]+$/, '').trim();
    if (musical.test(tidy(name))) return { name, oldName: null, rest: '', from: text };
    return null;
  }

  function parts(name) {
    const text = tidy(name.replace(/_/g, ' ').replace(/[()[\]{}:：]/g, ' '));
    const match = text.match(/^(.*?\D)\s*(\d+)$/);
    const base = tidy(match ? match[1] : text);
    const title = base.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
    return { base: title || 'Section', number: match && Number(match[2]) > 0 ? Number(match[2]) : null };
  }

  function headings(raw, structure) {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const candidates = lines.map(candidate);
    const reserved = new Map();
    for (const item of candidates.filter(Boolean)) {
      item.parts = parts(item.name);
      const k = key(item.parts.base);
      if (!reserved.has(k)) reserved.set(k, new Set());
      if (item.parts.number) reserved.get(k).add(item.parts.number);
    }
    const used = new Map();
    const oldNames = new Map();
    const changes = [];
    const rewritten = lines.map((line, i) => {
      const item = candidates[i];
      if (!item) return line;
      const k = key(item.parts.base);
      if (!used.has(k)) used.set(k, new Set());
      const taken = used.get(k);
      let number = item.parts.number;
      if (!number || taken.has(number)) {
        number = 1;
        while (taken.has(number) || reserved.get(k).has(number)) number += 1;
      }
      taken.add(number);
      const name = `${item.parts.base} ${number}`;
      if (item.oldName) {
        const oldKey = key(item.oldName);
        if (!oldNames.has(oldKey)) oldNames.set(oldKey, new Set());
        oldNames.get(oldKey).add(name);
      }
      const replacement = name + ':' + (item.rest ? eol + item.rest : '');
      if (replacement !== line) changes.push({ from: item.from, to: name + ':' });
      return replacement;
    });
    const warnings = [];
    // An old arrangement cannot disambiguate two different sections with the
    // same old name. Leave that song's headings for review instead of guessing.
    const ambiguous = (structure || []).some(item => item.type === 'section' && oldNames.get(key(item.sectionName))?.size > 1);
    if (ambiguous) return { text: raw, structure, changes: [], warnings: ['Repeated headings are referenced by an existing arrangement; review them before renaming.'], referenceChanges: 0 };

    let text = rewritten.join(eol);
    const first = text.split(/\r?\n/).findIndex(line => labelOf(line));
    const prefix = first < 0 ? text : text.split(/\r?\n/).slice(0, first).join(eol);
    const content = prefix.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('{'));
    if (content && (first < 0 || /\[[^\]]+\]/.test(prefix))) {
      const names = new Set([...parseChart(text).keys()]);
      let n = 1;
      while (names.has(`Song ${n}`)) n += 1;
      const rows = text.split(/\r?\n/);
      let at = 0;
      while (at < rows.length && (!rows[at].trim() || /^\s*\{[^}]+\}\s*$/.test(rows[at]))) at += 1;
      rows.splice(at, 0, `Song ${n}:`);
      text = rows.join(eol);
      changes.unshift({ from: '(unlabelled song text)', to: `Song ${n}:` });
    }
    let referenceChanges = 0;
    const nextStructure = structure?.map(item => {
      const set = typeof item.sectionName === 'string' && oldNames.get(key(item.sectionName));
      if (!set || set.size !== 1) return item;
      const name = [...set][0];
      if (name === item.sectionName) return item;
      referenceChanges += 1;
      return { ...item, sectionName: name };
    });
    return { text, structure: nextStructure, changes, warnings, referenceChanges };
  }

  function whitespace(raw) {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/).map(line => line.replace(/[\t \u00a0]+$/, ''));
    const result = [];
    let afterHeading = false;
    for (const line of lines) {
      if (!line.trim()) {
        if (!result.length || afterHeading || result.at(-1) === '') continue;
        result.push('');
      } else {
        result.push(line);
        afterHeading = !!labelOf(line);
      }
    }
    while (result.at(-1) === '') result.pop();
    return result.join(eol) + (raw.endsWith('\n') && result.length ? eol : '');
  }

  function plan(rawValue, structure, options) {
    const raw = String(rawValue || '');
    let text = raw;
    let nextStructure = structure;
    let headingChanges = [];
    let referenceChanges = 0;
    const warnings = [];
    const actions = [];
    if (options.headings) {
      const fixed = headings(text, nextStructure);
      text = fixed.text;
      nextStructure = fixed.structure;
      headingChanges = fixed.changes;
      referenceChanges = fixed.referenceChanges;
      warnings.push(...fixed.warnings);
      if (headingChanges.length) actions.push(`Normalize ${plural(headingChanges.length, 'heading')}`);
    }
    if (options.whitespace) {
      const cleaned = whitespace(text);
      if (cleaned !== text) actions.push('Clean trailing spaces and excess blank lines');
      text = cleaned;
    }
    if (options.beats) {
      const filled = fillMissingChordBeats(text);
      if (filled.count) actions.push(`Write 4 beats per chord in ${plural(filled.count, 'section')}`);
      text = filled.text;
    }
    const chart = parseChart(text);
    if (options.structure && chart.size && (!nextStructure || !nextStructure.some(item => item.type === 'section'))) {
      nextStructure = [...(nextStructure || []), ...[...chart.keys()].map(sectionName => ({ type: 'section', sectionName }))];
      actions.push('Build the missing song structure from headings');
    }
    if (options.structure && nextStructure) {
      const available = [...chart.keys()];
      nextStructure = nextStructure.map(item => {
        if (item.type !== 'section' || chart.has(item.sectionName)) return item;
        const matches = available.filter(name => key(name) === key(item.sectionName));
        if (matches.length !== 1) return item;
        referenceChanges += 1;
        return { ...item, sectionName: matches[0] };
      });
    }
    if (referenceChanges) actions.push(`Update ${plural(referenceChanges, 'section reference')} without removing MIDI events`);
    const missing = [...new Set((nextStructure || []).filter(item => item.type === 'section' && !chart.has(item.sectionName)).map(item => item.sectionName))];
    if (missing.length) warnings.push(`Arrangement refers to missing headings: ${missing.join(', ')}`);
    if (!chart.size) warnings.push('No section headings found. Review the song text.');
    const duplicates = duplicateLabels(text);
    if (duplicates.length) warnings.push(`Repeated headings need review: ${duplicates.join(', ')}`);
    const suspicious = [...chart.keys()].filter(name => /[|]|https?:\/\//i.test(name));
    if (suspicious.length) warnings.push('Some colon-ended lines look like tablature or links rather than headings. Review them.');
    return { text, structure: nextStructure, headingChanges, warnings, actions, changed: text !== raw || JSON.stringify(nextStructure) !== JSON.stringify(structure) };
  }
  return { plan };
})();

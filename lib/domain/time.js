// Singapore has no DST: local = UTC+08:00 all year.
export const TZ = 'Asia/Singapore';
const OFFSET_MIN = 8 * 60;

export function sgtToUtc(dateLocal, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const [Y, M, D] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - OFFSET_MIN * 60000).toISOString();
}

export function addDays(dateLocal, n) {
  const [Y, M, D] = dateLocal.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D + n)).toISOString().slice(0, 10);
}

export function utcToSgtDate(iso) {
  return new Date(Date.parse(iso) + OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

export function formatSgtTime(iso) {
  if (!iso) return '';
  return new Date(Date.parse(iso) + OFFSET_MIN * 60000).toISOString().slice(11, 16);
}

export function todaySgt(now = new Date()) {
  return utcToSgtDate(now.toISOString());
}

export function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

function to24(h, m, ampm) {
  let hh = Number(h) % 12;
  if (/pm/i.test(ampm)) hh += 12;
  return `${String(hh).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}

// Reads session timing from the free-text notes the history uses. Returns
// { started_at_utc, ended_at_utc, time_precision, reported_duration_min } or null.
// Only times actually written in a note are used.
export function parseTimingNote(note, dateLocal) {
  if (!note || !dateLocal) return null;
  let m = note.match(/Started (\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2}), ended (\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})/i);
  if (m) {
    return {
      started_at_utc: sgtToUtc(m[1], m[2]),
      ended_at_utc: sgtToUtc(m[3], m[4]),
      time_precision: 'exact',
      reported_duration_min: null,
    };
  }
  m = note.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s+to\s+(\d{1,2}):(\d{2})\s*(AM|PM)(\s+next day)?(?:;\s*(\d+)\s*minutes)?/i);
  if (m) {
    const start = to24(m[1], m[2], m[3]);
    const end = to24(m[4], m[5], m[6]);
    const endDate = m[7] || end < start ? addDays(dateLocal, 1) : dateLocal;
    return {
      started_at_utc: sgtToUtc(dateLocal, start),
      ended_at_utc: sgtToUtc(endDate, end),
      time_precision: 'exact',
      reported_duration_min: m[8] ? Number(m[8]) : null,
    };
  }
  m = note.match(/Started around (\d{1,2})(?::(\d{2}))?\s*(AM|PM),\s*finished around (\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (m) {
    const start = to24(m[1], m[2], m[3]);
    const end = to24(m[4], m[5], m[6]);
    return {
      started_at_utc: sgtToUtc(dateLocal, start),
      ended_at_utc: sgtToUtc(end < start ? addDays(dateLocal, 1) : dateLocal, end),
      time_precision: 'approximate',
      reported_duration_min: null,
    };
  }
  return null;
}

// Duration with its provenance: measured start/end beats a reported figure.
export function sessionDuration(session) {
  const m = minutesBetween(session.started_at_utc, session.ended_at_utc);
  if (m !== null) return { minutes: m, source: session.time_precision === 'approximate' ? 'approximate start/end' : 'start/end' };
  if (session.reported_duration_min) return { minutes: session.reported_duration_min, source: 'reported' };
  return { minutes: null, source: 'unknown' };
}

export function formatDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

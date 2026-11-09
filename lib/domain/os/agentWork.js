// FILE: lib/domain/os/agentWork.js
// The work a person gives an agent when they start it ("Lay out the next 60
// days and tell me which week runs short").
//
// Agents are fixed code, not a language model, so they do not "understand"
// free text. This module does two honest things with it:
//   1. cleans it and stores it on the run, so the run page shows exactly what
//      the person asked for, and
//   2. reads the few settings a fixed agent can actually take from it (today:
//      a time horizon like "60 days", "8 weeks" or "2 months"), and says
//      which ones it used. Anything else is kept as a note on the run, never
//      acted on, and the run says so.
//
// Nothing here can make an agent contact anyone or change a record.

const MAX_INSTRUCTION = 1000;

/** Trim, drop control characters, cap the length. Empty means "no instruction". */
function cleanInstruction(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    const err = new Error('instruction must be text');
    err.status = 400;
    throw err;
  }
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+\n/g, '\n').trim();
  if (!text) return null;
  if (text.length > MAX_INSTRUCTION) {
    const err = new Error(`Keep the instruction under ${MAX_INSTRUCTION} characters`);
    err.status = 400;
    throw err;
  }
  return text;
}

const UNIT_DAYS = { day: 1, days: 1, week: 7, weeks: 7, wk: 7, wks: 7, month: 30, months: 30, mo: 30 };
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, a: 1 };

/** A horizon in days from text like "next 60 days", "8 weeks", "two months". */
function horizonFromInstruction(text) {
  if (!text) return null;
  const m = String(text).toLowerCase().match(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a)\s*-?\s*(days?|weeks?|wks?|wk|months?|mo)\b/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1]];
  const unit = UNIT_DAYS[m[2]];
  if (!n || !unit) return null;
  return n * unit;
}

/**
 * What a fixed agent takes from an instruction. Returns the settings it will
 * use and a plain sentence the run page shows under the request.
 */
function readInstruction(agentKey, text, { workingCapitalKey, horizonLimits = [7, 90] } = {}) {
  if (!text) return { settings: {}, understood: null };
  if (agentKey === workingCapitalKey) {
    const h = horizonFromInstruction(text);
    if (h != null) {
      const [lo, hi] = horizonLimits;
      const used = Math.max(lo, Math.min(hi, h));
      const note = used === h
        ? `I took a ${used}-day horizon from your instruction.`
        : `You asked for ${h} days; I can look between ${lo} and ${hi} days ahead, so I used ${used}.`;
      return { settings: { horizonDays: used }, understood: `${note} I am fixed code, so the rest of your note is kept with the run, not acted on.` };
    }
    return { settings: {}, understood: 'I am fixed code and only take a time horizon (like "next 60 days") from an instruction. I used my default and kept your note with the run.' };
  }
  return { settings: {}, understood: 'I am fixed code: I run the same steps every time. Your note is kept with the run so you can see why it was started.' };
}

module.exports = { cleanInstruction, horizonFromInstruction, readInstruction, MAX_INSTRUCTION };

'use strict';
// Similar-decision memory: earlier decisions of this business that look like
// the one in front of the owner, with what was chosen and what actually
// happened. Read-only and deterministic; the similarity score is shown with
// its parts so nobody has to trust a black box.
//
//   same customer          0.5  (shares a customer in affected_entities)
//   same warning signs     0.3  (Jaccard overlap of trigger codes)
//   similar size           0.2  (exposure within the same order of magnitude)
// Only the same kind of decision is compared. Below MIN_SCORE nothing is shown.

const MIN_SCORE = 0.3;

const list = (v) => (Array.isArray(v) ? v : []);

function customerKeys(d) {
  return new Set(list(d.affected_entities).filter((e) => e && e.type === 'customer').map((e) => e.key || String(e.name || '').toLowerCase()));
}
function triggerCodes(d) {
  return new Set(list(d.trigger_signals).map((t) => t && t.code).filter(Boolean));
}
function exposure(d) {
  const m = d.materiality || {};
  return Number(m.exposure ?? m.expectedUncollected90 ?? m.workingCapitalTiedUp ?? 0) || 0;
}

function similarity(current, past) {
  const a = customerKeys(current);
  const sameCustomer = [...customerKeys(past)].some((k) => a.has(k)) ? 1 : 0;
  const ta = triggerCodes(current);
  const tb = triggerCodes(past);
  const union = new Set([...ta, ...tb]);
  const signs = union.size ? [...ta].filter((c) => tb.has(c)).length / union.size : 0;
  const ea = exposure(current);
  const eb = exposure(past);
  const size = ea > 0 && eb > 0 ? Math.max(0, 1 - Math.abs(Math.log10(ea / eb))) : 0;
  const score = 0.5 * sameCustomer + 0.3 * signs + 0.2 * size;
  return { score: Number(score.toFixed(3)), parts: { sameCustomer: !!sameCustomer, sharedSigns: [...ta].filter((c) => tb.has(c)), sizeSimilarity: Number(size.toFixed(2)) } };
}

function optionLabel(d, key) {
  if (!key) return null;
  const all = [...list(d.options), d.do_nothing_option].filter(Boolean);
  return all.find((o) => o.key === key)?.label || key;
}

function outcomeOf(contract) {
  if (!contract) return { status: 'NO_ACTION_RECORDED', detail: null, attribution: null };
  const v = contract.verification || {};
  return { status: contract.status, detail: v.reason || null, attribution: contract.attribution || null };
}

async function findSimilarDecisions(pool, userId, decision, { limit = 5 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, title, status, affected_entities, trigger_signals, materiality, options, do_nothing_option,
            selected_option, resolution_reason, resolved_at, created_at
       FROM decisions
      WHERE user_id = $1 AND kind = $2 AND id <> $3
      ORDER BY created_at DESC LIMIT 200`,
    [userId, decision.kind, decision.id],
  );
  const scored = rows
    .map((p) => ({ p, sim: similarity(decision, p) }))
    .filter((x) => x.sim.score >= MIN_SCORE)
    .sort((x, y) => y.sim.score - x.sim.score)
    .slice(0, limit);
  if (!scored.length) {
    return { similar: [], note: rows.length ? 'No earlier decision is close enough to compare.' : 'This is the first decision of its kind, so there is no history to compare yet.' };
  }
  const ids = scored.map((x) => x.p.id);
  const contracts = await pool.query(
    `SELECT DISTINCT ON (decision_id) decision_id, status, verification, attribution, regret, review_at
       FROM decision_contracts WHERE user_id = $1 AND decision_id = ANY($2::uuid[]) AND status <> 'SUPERSEDED'
      ORDER BY decision_id, created_at DESC`,
    [userId, ids],
  );
  const contractOf = new Map(contracts.rows.map((c) => [c.decision_id, c]));
  return {
    similar: scored.map(({ p, sim }) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      decidedAt: p.resolved_at || null,
      createdAt: p.created_at,
      chosen: optionLabel(p, p.selected_option),
      outcome: outcomeOf(contractOf.get(p.id)),
      regret: contractOf.get(p.id)?.regret ?? null,
      similarity: sim.score,
      why: sim.parts,
    })),
    method: 'Same kind of decision; 0.5 same customer + 0.3 shared warning signs + 0.2 similar size. Shown when 0.3 or more.',
  };
}

module.exports = { findSimilarDecisions, similarity, MIN_SCORE };

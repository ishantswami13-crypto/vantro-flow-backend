// FILE: lib/domain/intelligence/intelligenceMerge.js
// STARLANE Multidimensional Intelligence Expansion — Capability 6:
// Intelligence Merge (signal compaction / deduplication).
//
// A pure function: merges overlapping signals about the SAME underlying real
// entity (e.g. a cash-risk signal + a customer-concentration signal + a
// payment-deterioration signal that all point at the same customerId) into
// one richer merged object, instead of surfacing 3 separate repetitive
// items. This is deduplication/compaction logic only — it invents no new
// evidence, no new confidence, and no new severity; it only combines what
// each input signal already honestly asserted.
//
// Input contract: an array of "signal" objects, each with at minimum:
//   { entityType: string, entityId: string, sourceType: string, severity?: 'LOW'|'MEDIUM'|'HIGH', evidence?: any, statement?: string }
// Signals with the same (entityType, entityId) are grouped and merged.
// Signals for different entities are left as separate, un-merged items —
// this module never merges across different real entities.

const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

function severityRank(sev) {
  return SEVERITY_RANK[sev] || 0;
}

function keyFor(signal) {
  return `${signal.entityType}::${signal.entityId}`;
}

/**
 * @param {Array<object>} signals
 * @returns {{merged: Array<object>, mergedCount: number, originalCount: number}}
 */
function mergeOverlappingSignals(signals) {
  if (!Array.isArray(signals)) throw new Error('mergeOverlappingSignals: signals must be an array');
  const validSignals = signals.filter(s => s && s.entityType && s.entityId);

  const groups = new Map();
  for (const s of validSignals) {
    const key = keyFor(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const merged = [];
  for (const [key, group] of groups.entries()) {
    if (group.length === 1) {
      merged.push({ ...group[0], mergedFromCount: 1, sourceTypes: [group[0].sourceType].filter(Boolean) });
      continue;
    }
    const sourceTypes = [...new Set(group.map(g => g.sourceType).filter(Boolean))];
    const maxSeverity = group.reduce((max, g) => (severityRank(g.severity) > severityRank(max) ? g.severity : max), 'LOW');
    const statements = group.map(g => g.statement).filter(Boolean);
    const evidence = group.map((g, i) => ({ sourceType: g.sourceType || `source_${i}`, evidence: g.evidence ?? null, statement: g.statement ?? null, severity: g.severity ?? null }));

    merged.push({
      entityType: group[0].entityType,
      entityId: group[0].entityId,
      mergedFromCount: group.length,
      sourceTypes,
      severity: maxSeverity,
      severityBasis: `highest of ${group.length} merged real signals' own severities: [${group.map(g => g.severity || 'UNSET').join(', ')}]`,
      statements,
      evidence,
      statement: `${group.length} real signals from distinct sources (${sourceTypes.join(', ')}) all concern the same entity (${group[0].entityType} ${group[0].entityId}) — compacted into one item rather than shown as ${group.length} separate repetitive alerts.`,
    });
  }

  return {
    merged,
    mergedCount: merged.length,
    originalCount: validSignals.length,
    compactionRatio: validSignals.length > 0 ? Math.round((1 - merged.length / validSignals.length) * 1000) / 1000 : 0,
  };
}

module.exports = { mergeOverlappingSignals, SEVERITY_RANK };

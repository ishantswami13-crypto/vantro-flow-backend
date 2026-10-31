// FILE: lib/db/fetchAllRows.js
// Read every matching row through supabase-js, a page at a time.
//
// Supabase (PostgREST) caps one response at its "max rows" setting, 1,000 by
// default, and says nothing when it does: the 1,001st pending invoice or user
// is simply not in the array. Jobs that walk all tenants or all pending
// invoices therefore stopped at the cap without an error. build() must return
// a fresh query (select + filters) each call; pages are ordered by `orderBy`
// so no row is skipped or seen twice between pages.

async function fetchAllRows(build, { orderBy = 'id', pageSize = 1000, maxRows = 500000 } = {}) {
  const out = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build().order(orderBy, { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

module.exports = { fetchAllRows };

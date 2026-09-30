// The assistant's tool policy: no tool that changes records is ever allowed,
// every tool the model can be offered is classified, and apps get look-ups only.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { allowedToolsFor, READ_TOOLS, DRAFT_TOOLS } = require('./assistantTools');

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };
const MUTATING = ['mark_invoice_paid', 'add_prospect', 'update_prospect_status', 'place_order_with_supplier'];

const web = allowedToolsFor({ native: false });
const app = allowedToolsFor({ native: true });
check('web: no record-changing tool', MUTATING.every((t) => !web.has(t)));
check('apps: no record-changing tool', MUTATING.every((t) => !app.has(t)));
check('apps: no message drafts either', DRAFT_TOOLS.every((t) => !app.has(t)));
check('web: can look things up and draft', READ_TOOLS.every((t) => web.has(t)) && DRAFT_TOOLS.every((t) => web.has(t)));
check('unknown future tools are refused', !web.has('delete_invoice') && !app.has('delete_invoice'));

// Every tool defined in server.js must be either allowed or known-mutating: a
// new tool cannot slip in unclassified.
const src = require('fs').readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const defined = [...src.matchAll(/function:\{ name:'([a-z_]+)'/g)].map((m) => m[1]);
check('server.js tool list was found', defined.length >= 10);
const unclassified = defined.filter((t) => !web.has(t) && !MUTATING.includes(t));
check(`every defined tool is classified${unclassified.length ? ` (unclassified: ${unclassified.join(', ')})` : ''}`, unclassified.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

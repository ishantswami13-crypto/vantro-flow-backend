// FILE: lib/domain/ingestion/adapters/index.js
// Registry of source adapters conforming to the discover/extract/normalize
// interface documented in adapters/README.md.

const tallyAdapter = require('./tallyAdapter');
const fileAdapter = require('./fileAdapter');

module.exports = {
  tally: tallyAdapter,
  file: fileAdapter,
};

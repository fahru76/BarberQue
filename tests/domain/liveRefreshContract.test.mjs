import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('        function mergeServerRows(');
const end = html.indexOf('\n        // A burst of writes on another device', start);
if (start < 0 || end < 0) throw new Error('mergeServerRows definition not found');
const source = html.slice(start, end);
const mergeServerRows = new Function(`${source}; return mergeServerRows;`)();

const local = [
    { id: 'LIVE-STALE', status: 'serving', seat: 1 },
    { id: 'DONE-HISTORY', status: 'done', seat: 1 },
    { id: 'CANCEL-HISTORY', status: 'cancelled', seat: null },
    { id: 'LIVE-KEEP', status: 'waiting', seat: null }
];
const fresh = [
    { id: 'LIVE-KEEP', status: 'waiting', seat: null },
    { id: 'NEW-LIVE', status: 'serving', seat: 2 }
];
const result = mergeServerRows(local, fresh);
const ids = result.map(row => row.id);
const assert = (name, condition) => {
    if (!condition) throw new Error(`FAIL ${name}`);
    console.log(`  pass  ${name}`);
};

console.log('\nAuthoritative live refresh merge');
assert('stale active row is pruned', !ids.includes('LIVE-STALE'));
assert('fresh active row is retained', ids.includes('LIVE-KEEP'));
assert('new server row is added', ids.includes('NEW-LIVE'));
assert('completed history is preserved', ids.includes('DONE-HISTORY'));
assert('cancelled history is preserved', ids.includes('CANCEL-HISTORY'));
console.log('\n5 passed');

import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const failures = [];
const ok = (name, condition) => {
    if (condition) console.log(`  pass  ${name}`);
    else { failures.push(name); console.log(`  FAIL  ${name}`); }
};

console.log('\nServer-authoritative walk-in/cancellation contracts');
ok('walk-in failure does not mint a local-only ticket',
    html.includes('tiket tidak dikeluarkan') && !html.includes('guna kaunter tempatan sahaja'));
const cancelBody = html.slice(html.indexOf('async function cancelCustomerWalkin()'), html.indexOf('async function startWalkinConversion()'));
ok('walk-in cancellation calls server before local cancellation mutation',
    cancelBody.indexOf('const cancelled = await window.QueueRepo.cancelOwn') < cancelBody.indexOf("queue.status = 'cancelled'"));
ok('queue hydration only uses staff RPC for active staff',
    html.includes('staffSession && staffProfile?.active'));
ok('admin queue attribution is preserved separately from raw actor',
    fs.readFileSync('js/repositories/queueRepository.js', 'utf8').includes('cancelledByAdmin'));

console.log(`\n${failures.length ? failures.length + ' failed' : '4 passed'}`);
if (failures.length) process.exit(1);

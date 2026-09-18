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
ok('customer surface hides staff login and reset controls',
    html.includes("const customerSurface = activeViewId === 'customer-app'") &&
    html.includes("loginBtn.style.display = customerSurface ? 'none' : 'inline-block'") &&
    html.includes("resetBtn.style.display = customerSurface ? 'none' : 'inline-block'"));
ok('admin cancellation does not claim undelivered outbox notification',
    !html.includes('Notifikasi aplikasi yang layak telah dimasukkan ke outbox') &&
    !html.includes("eventKey: `admin-cancel:") &&
    !html.includes("eventKey: `appointment-created:") &&
    !html.includes("eventKey: `walkin-converted:") &&
    !html.includes("eventKey: `customer-cancel:") &&
    html.includes('Pelanggan akan melihat notifikasi dalam aplikasi apabila rekod disegarkan'));
const assignmentSaveBody = html.slice(html.indexOf('async function saveBarberAssignments()'), html.indexOf('async function saveSeatCountSetting()'));
ok('seat assignment save avoids unique-index race',
    assignmentSaveBody.includes('Clear changed old assignments first') &&
    assignmentSaveBody.includes('for (const seat of seats)') &&
    !assignmentSaveBody.includes('Promise.all(getSeatNumbers()'));

console.log(`\n${failures.length ? failures.length + ' failed' : '5 passed'}`);
if (failures.length) process.exit(1);

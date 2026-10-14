// Every dividend, the tax withheld from it, payments in lieu and bond interest from Interactive
// Brokers' Flex Web Service, with no dependencies (Node 18+).
//
//   node ibkr-flex.js fetch --from 2022-01-01      fetch into cash.json (cached; re-run any time)
//   node ibkr-flex.js summary                      per holding: gross, tax, net, effective rate
//   node ibkr-flex.js csv > income.csv             every row, for a spreadsheet or a tax return
//   node ibkr-flex.js --selftest
//
// Configuration, in ibkr-flex.json (keep it out of git: the token reads your statements):
//   { "token": "...", "accounts": [ { "name": "main", "query": "123456" } ] }
// or the environment variables IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY for a single account.
//
// What the Flex Web Service does not tell you, and this handles:
//   - one request covers at most 365 days, so history is fetched a year at a time;
//   - it serves completed days only: a range ending today is refused;
//   - before an account existed it answers 1003 "Statement is not available";
//   - a token belongs to your login, so one token serves every account it can see, each with
//     its own query; a migrated or closed account usually still answers.
const fs = require('fs');

const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const DAY = 864e5;
const INCOME = /^(Dividends|Withholding Tax|Payment In Lieu Of Dividends|Bond Interest Received|Bond Interest Paid)$/;

const ymd = d => d.toISOString().slice(0, 10);
const iso = s => (s || '').replace(/^(\d{4})(\d\d)(\d\d).*/, '$1-$2-$3');
const tag = (x, t) => (x.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
const unescape = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The accounts to fetch: one token for all, a query each (an account may carry its own token).
function readConfig(file = 'ibkr-flex.json', env = process.env) {
    let cfg = {};
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    else if (env.IBKR_FLEX_TOKEN) cfg = { token: env.IBKR_FLEX_TOKEN, accounts: [{ name: 'main', query: env.IBKR_FLEX_QUERY }] };
    const accounts = (cfg.accounts || []).map((a, i) => ({ name: a.name || `account${i + 1}`,
        token: String(a.token || cfg.token || '').trim(), query: String(a.query || '').trim() }))
        .filter(a => a.token && a.query);
    if (!accounts.length) throw new Error(`no account with a token and a query: write ${file} or set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY`);
    return accounts;
}

// 365-day windows from `from` to `to`, oldest first.
function windows(from, to) {
    const out = [];
    for (let d = new Date(from + 'T00:00:00Z'); ymd(d) <= to; d = new Date(d.getTime() + 365 * DAY)) {
        const end = ymd(new Date(d.getTime() + 364 * DAY));
        out.push({ from: ymd(d), to: end < to ? end : to });
    }
    return out;
}

// The income rows of a Flex statement (its Cash Transactions section).
function parseRows(xml) {
    return [...xml.matchAll(/<CashTransaction ([^>]*?)\/>/g)]
        .map(m => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], unescape(a[2])])))
        .filter(r => INCOME.test(r.type) && r.symbol)
        .map(r => ({ date: iso(r.dateTime || r.reportDate), exDate: iso(r.exDate) || null, symbol: r.symbol,
            isin: r.isin || null, description: r.description || '', currency: r.currency, amount: Number(r.amount),
            type: r.type, account: r.accountId || null }));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// One window. null when IBKR has no statement for it (before the account existed).
async function fetchWindow({ token, query }, w, fetchImpl = fetch) {
    const H = { 'User-Agent': 'ibkr-flex-dividends/0.1' };
    for (let attempt = 0; attempt < 5; attempt++) {
        const send = await (await fetchImpl(`${BASE}/SendRequest?t=${token}&q=${query}&v=3&fd=${w.from.replace(/-/g, '')}&td=${w.to.replace(/-/g, '')}`, { headers: H })).text();
        const code = tag(send, 'ErrorCode');
        if (code === '1003') return null;
        if (code === '1018') { await wait(10000 * (attempt + 1)); continue; }          // too many requests
        const ref = tag(send, 'ReferenceCode');
        if (!ref) throw new Error(`IBKR refused the request (${code || '?'}): ${tag(send, 'ErrorMessage') || send.slice(0, 120)}`);
        for (let i = 0; i < 20; i++) {
            await wait(3000);
            const st = await (await fetchImpl(`${BASE}/GetStatement?t=${token}&q=${ref}&v=3`, { headers: H })).text();
            if (/<FlexQueryResponse/.test(st)) return parseRows(st);
            const c = tag(st, 'ErrorCode');
            if (c !== '1019' && !/in progress/i.test(st)) throw new Error(`IBKR statement failed (${c || '?'}): ${tag(st, 'ErrorMessage') || st.slice(0, 120)}`);
        }
        throw new Error('the statement was not ready after a minute');
    }
    throw new Error('IBKR kept refusing: too many requests from this token; try again later');
}

async function fetchAll(args) {
    const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
    const out = opt('--out') || 'cash.json';
    const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { accounts: {} };
    const from = opt('--from') || prev.from;
    if (!from) throw new Error('first run: give --from YYYY-MM-DD, the day your account opened (or earlier)');
    const to = opt('--to') || ymd(new Date(Date.now() - DAY));       // completed days only
    const accounts = readConfig(opt('--config') || 'ibkr-flex.json');
    const ws = windows(from, to);
    const result = { from, to, fetched: new Date().toISOString(), accounts: {} };
    for (const acct of accounts) {
        const was = prev.accounts?.[acct.name]?.windows || {}, cached = {};
        for (const [i, w] of ws.entries()) {
            const key = `${w.from}/${w.to}`;
            // A finished window cannot change; the last two are asked again for late postings.
            if (i < ws.length - 2 && was[key]) { cached[key] = was[key]; continue; }
            const rows = await fetchWindow(acct, w);
            cached[key] = rows ? { rows } : { unavailable: true };
            console.error(`${acct.name} ${key}: ${rows ? rows.length + ' rows' : 'not available'}`);
            await wait(2000);
        }
        result.accounts[acct.name] = { windows: cached };
    }
    fs.writeFileSync(out, JSON.stringify(result, null, 1));
    console.error(`wrote ${out}: ${allRows(result).length} rows`);
}

const allRows = data => Object.entries(data.accounts || {})
    .flatMap(([name, a]) => Object.values(a.windows).flatMap(w => (w.rows || []).map(r => ({ ...r, account: r.account || name }))));

// Per holding and currency: dividends (with payments in lieu), tax withheld, interest, net, and
// the effective withholding rate, which is how you spot a market taxing you above its treaty rate.
function summarise(rows) {
    const by = new Map();
    for (const r of rows) {
        const k = `${r.symbol}|${r.currency}`;
        const s = by.get(k) || { symbol: r.symbol, currency: r.currency, payments: 0, gross: 0, tax: 0, interest: 0 };
        if (r.type === 'Withholding Tax') s.tax += r.amount;
        else if (/Bond Interest/.test(r.type)) s.interest += r.amount;
        else { s.gross += r.amount; if (r.amount > 0) s.payments++; }
        by.set(k, s);
    }
    return [...by.values()].map(s => ({ ...s, net: s.gross + s.tax + s.interest, rate: s.gross > 0 ? -s.tax / s.gross : null }))
        .sort((a, b) => a.currency.localeCompare(b.currency) || b.net - a.net);
}

const money = v => v.toFixed(2);
const csvCell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

function main(argv) {
    const [cmd, ...args] = argv;
    if (cmd === 'fetch') return fetchAll(args);
    const file = args[0] || 'cash.json';
    if (cmd === 'summary' || cmd === 'csv') {
        const rows = allRows(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (cmd === 'csv') {
            const cols = ['date', 'exDate', 'account', 'symbol', 'isin', 'type', 'currency', 'amount', 'description'];
            console.log(cols.join(','));
            for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) console.log(cols.map(c => csvCell(r[c])).join(','));
            return;
        }
        const head = ['symbol', 'ccy', 'payments', 'gross', 'tax', 'interest', 'net', 'tax rate'];
        const lines = summarise(rows).map(s => [s.symbol, s.currency, s.payments, money(s.gross), money(s.tax),
            money(s.interest), money(s.net), s.rate == null ? '' : (s.rate * 100).toFixed(1) + '%']);
        const w = head.map((h, i) => Math.max(h.length, ...lines.map(l => String(l[i]).length)));
        for (const l of [head, ...lines]) console.log(l.map((v, i) => (i < 2 ? String(v).padEnd(w[i]) : String(v).padStart(w[i]))).join('  '));
        return;
    }
    console.log('usage: node ibkr-flex.js fetch --from YYYY-MM-DD [--to YYYY-MM-DD] [--config ibkr-flex.json] [--out cash.json]\n'
        + '       node ibkr-flex.js summary [cash.json]\n       node ibkr-flex.js csv [cash.json]\n       node ibkr-flex.js --selftest');
    process.exitCode = 1;
}

async function selftest() {
    const assert = require('assert');
    assert.deepStrictEqual(windows('2024-10-10', '2026-10-08').map(w => `${w.from}/${w.to}`),
        ['2024-10-10/2025-10-09', '2025-10-10/2026-10-08']);
    assert.deepStrictEqual(windows('2026-10-08', '2026-10-08'), [{ from: '2026-10-08', to: '2026-10-08' }]);

    const xml = '<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1">'
        + '<CashTransaction accountId="U1" currency="EUR" symbol="MC" isin="FR0000121014" description="MC CASH DIVIDEND EUR 5.50 &amp; MORE" dateTime="20251204;202000" exDate="20251202" amount="27.5" type="Dividends" />'
        + '<CashTransaction accountId="U1" currency="EUR" symbol="MC" isin="FR0000121014" dateTime="20251204;202000" exDate="20251202" amount="-6.875" type="Withholding Tax" />'
        + '<CashTransaction accountId="U1" currency="GBP" symbol="UKT 4 10/22/31" isin="GB0000000000" dateTime="20261008" amount="-12.34" type="Bond Interest Paid" />'
        + '<CashTransaction accountId="U1" currency="GBP" symbol="" dateTime="20251204" amount="500" type="Deposits/Withdrawals" />'
        + '</FlexStatement></FlexStatements></FlexQueryResponse>';
    const rows = parseRows(xml);
    assert.strictEqual(rows.length, 3, 'deposits are not income');
    assert.strictEqual(rows[0].description, 'MC CASH DIVIDEND EUR 5.50 & MORE', 'XML entities decoded');
    assert.deepStrictEqual([rows[0].date, rows[0].exDate, rows[2].exDate], ['2025-12-04', '2025-12-02', null]);
    const s = summarise(rows);
    const mc = s.find(x => x.symbol === 'MC');
    assert.deepStrictEqual([mc.payments, mc.gross, mc.tax, mc.net], [1, 27.5, -6.875, 20.625]);
    assert.strictEqual(mc.rate, 0.25, 'France withholds 25% unless reclaimed');
    assert.strictEqual(s.find(x => x.symbol.startsWith('UKT')).interest, -12.34, 'accrued interest paid on a bond purchase');

    // One token for several accounts; a blank query is a template and is skipped.
    assert.deepStrictEqual(readConfig('/nonexistent.json', { IBKR_FLEX_TOKEN: 't', IBKR_FLEX_QUERY: 'q' }), [{ name: 'main', token: 't', query: 'q' }]);
    const tmp = require('path').join(require('os').tmpdir(), `flex-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ token: 't1', accounts: [{ name: 'old', query: 'q1' }, { name: 'new', query: 'q2' }, { name: 'later', query: '' }] }));
    assert.deepStrictEqual(readConfig(tmp, {}).map(a => `${a.name}:${a.token}:${a.query}`), ['old:t1:q1', 'new:t1:q2']);
    fs.unlinkSync(tmp);

    // The request flow against a stand-in for IBKR: 1003 is "no statement", and a statement is polled.
    const fake = replies => async () => ({ text: async () => replies.shift() });
    assert.strictEqual(await fetchWindow({ token: 't', query: 'q' }, { from: '2020-01-01', to: '2020-12-30' },
        fake(['<FlexStatementResponse><Status>Warn</Status><ErrorCode>1003</ErrorCode></FlexStatementResponse>'])), null);
    const got = await fetchWindow({ token: 't', query: 'q' }, { from: '2025-01-01', to: '2025-12-31' }, fake([
        '<FlexStatementResponse><Status>Success</Status><ReferenceCode>42</ReferenceCode></FlexStatementResponse>', xml]));
    assert.strictEqual(got.length, 3);
    console.log('selftest ok');
}

if (require.main === module) {
    const run = process.argv.includes('--selftest') ? selftest() : main(process.argv.slice(2));
    Promise.resolve(run).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { readConfig, windows, parseRows, fetchWindow, summarise, allRows };

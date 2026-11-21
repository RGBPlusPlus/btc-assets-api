import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const genesis = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const hash = 'f'.repeat(64);
const address = 'test-fixture';
const data = Array.from({ length: 501 }, (_, i) => ({
  txid: i.toString(16).padStart(64, '0'),
  vout: i,
  value: i + 1000,
  status: { confirmed: i < 500 },
}));
const ckb = '0x' + '9'.repeat(64);
const info = { bestblockhash: hash, blocks: 100, chain: 'test' };
const ready = { blockbook: { inSync: true, inSyncMempool: true, bestHeight: 100 }, backend: { bestBlockHash: hash } };
const auth = 'Bearer unit-test-only';
const origin = 'https://example.test';
let oracleCorrupt = false;
let oracleStatus = ready;
let indexedTipReads = 0;
let wrongIndexedTip = false;
let strictMinimum = false;
let omitMempool = false;
let noJWTLeak = true;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const isOracle = url.pathname.startsWith('/oracle/');
  if (isOracle && (req.headers.authorization || req.headers.origin)) noJWTLeak = false;
  if (!isOracle && (req.headers.authorization !== auth || req.headers.origin !== origin)) {
    res.writeHead(401).end();
    return;
  }
  let response;
  switch (url.pathname) {
    case '/api/healthcheck':
      response = { status: 'ok' };
      break;
    case '/api/bitcoin/v1/info':
      response = info;
      break;
    case '/api/bitcoin/v1/block/height/0':
      response = { hash: genesis };
      break;
    case '/oracle/api/v2/block-index/0':
      response = { blockHash: genesis };
      break;
    case '/oracle/api/v2/block-index/100':
      indexedTipReads++;
      if (oracleStatus.blockbook.bestHeight < info.blocks) {
        res.writeHead(404).end();
        return;
      }
      response = { blockHash: wrongIndexedTip ? 'e'.repeat(64) : hash };
      break;
    case '/oracle/api/':
      response = oracleStatus;
      break;
    case '/api/rgbpp/v1/address/' + address + '/assets':
      assert.equal(url.searchParams.get('no_cache'), 'true');
      response = [{ outPoint: { txHash: ckb, index: '0x0001' } }];
      break;
    case '/api/bitcoin/v1/address/' + address + '/unspent': {
      assert.equal(url.searchParams.get('no_cache'), 'true');
      const confirmedOnly = (url.searchParams.get('only_confirmed') ?? 'true') === 'true';
      response = data.filter(
        (row) =>
          (!omitMempool || row.status.confirmed) &&
          (!confirmedOnly || row.status.confirmed) &&
          (strictMinimum
            ? row.value > Number(url.searchParams.get('min_satoshi') ?? '0')
            : row.value >= Number(url.searchParams.get('min_satoshi') ?? '0')),
      );
      break;
    }
    case '/oracle/api/v2/utxo/' + address:
      assert.equal(url.searchParams.get('confirmed'), 'false');
      response = data.map(({ txid, vout, value, status }, i) => ({
        txid,
        vout,
        value: String(value + Number(oracleCorrupt && i === 1)),
        confirmations: Number(status.confirmed),
      }));
      break;
    default:
      res.writeHead(404).end();
      return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const root = 'http://127.0.0.1:' + server.address().port;
const env = {
  ...process.env,
  E2E_ASSET_API_URL: root + '/api',
  E2E_BTC_NETWORK: 'testnet',
  E2E_BTC_ADDRESS: address,
  E2E_BTC_OUTPOINT: data[0].txid + ':0',
  E2E_BTC_VALUE_SATS: String(data[0].value),
  E2E_BTC_MIN_UTXOS: '501',
  E2E_BTC_UNCONFIRMED_OUTPOINT: data.at(-1).txid + ':500',
  E2E_BLOCKBOOK_URL: root + '/oracle',
  E2E_ASSET_API_JWT: auth.split(' ')[1],
  E2E_ASSET_API_ORIGIN: origin,
  E2E_RGBPP_OUTPOINT: ckb + ':0x01',
};
async function run(overrides) {
  const suite = fileURLToPath(new URL('./asset-api-e2e.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', suite], {
    // The fixture checks TAP diagnostics. Do not let ambient Node flags select another reporter.
    env: { ...env, ...overrides, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert(!output.includes(auth.split(' ')[1]), 'JWT must not appear in output');
  return { code, output };
}
try {
  const defaultConfirmed = await fetch(`${root}/api/bitcoin/v1/address/${address}/unspent?no_cache=true`, {
    headers: { Authorization: auth, Origin: origin },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(defaultConfirmed.status, 200);
  assert.deepEqual(await defaultConfirmed.json(), data.filter((row) => row.status.confirmed));
  const all = await run({});
  assert.equal(all.code, 0, all.output);
  assert.match(all.output, /^# pass 5$/m);
  console.log(all.output);
  const bareOptions = {
    E2E_BLOCKBOOK_URL: '',
    E2E_RGBPP_OUTPOINT: '',
    E2E_BTC_UNCONFIRMED_OUTPOINT: '',
    E2E_BTC_MIN_UTXOS: '',
  };
  const bare = await run(bareOptions);
  assert.equal(bare.code, 0, bare.output);
  assert.match(bare.output, /^# pass 2$/m);
  assert.match(bare.output, /^# skipped 3$/m);
  const badFixture = await run({ E2E_BTC_VALUE_SATS: '1001' });
  assert.equal(badFixture.code, 1);
  assert.match(badFixture.output, /known fixture UTXO is incorrect or missing/);
  const truncated = await run({ E2E_BTC_MIN_UTXOS: '502' });
  assert.equal(truncated.code, 1);
  assert.match(truncated.output, /expected at least 502 UTXOs; got 501/);
  strictMinimum = true;
  const wrongBoundary = await run(bareOptions);
  assert.equal(wrongBoundary.code, 1);
  assert.match(wrongBoundary.output, /inclusive minimum-value filter: mismatch/);
  strictMinimum = false;
  omitMempool = true;
  const missingMempool = await run({ E2E_BLOCKBOOK_URL: '', E2E_BTC_MIN_UTXOS: '' });
  assert.equal(missingMempool.code, 1);
  assert.match(missingMempool.output, /known unconfirmed output is missing/);
  omitMempool = false;
  const insecure = await run({ E2E_ASSET_API_URL: 'http://must-not-be-contacted.invalid' });
  assert.equal(insecure.code, 1);
  assert.match(insecure.output, /E2E_ASSET_API_JWT requires HTTPS or a literal loopback/);
  const missing = await run({ E2E_BTC_OUTPOINT: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Set E2E_BTC_OUTPOINT before running/);
  for (const [inSync, message] of [
    [false, /Blockbook is not synced/],
    [true, /Blockbook and Asset API heights differ/],
  ]) {
    oracleStatus = { ...ready, blockbook: { ...ready.blockbook, inSync, bestHeight: info.blocks - 1 } };
    const before = indexedTipReads;
    const laggingOracle = await run({});
    assert.equal(laggingOracle.code, 1);
    assert.match(laggingOracle.output, message);
    assert.equal(indexedTipReads, before, 'must not query an unindexed height');
  }
  oracleStatus = ready;
  wrongIndexedTip = true;
  const badTip = await run({});
  assert.equal(badTip.code, 1);
  assert.match(badTip.output, /Blockbook indexed block differs/);
  wrongIndexedTip = false;
  oracleCorrupt = true;
  const badOracle = await run({});
  assert.equal(badOracle.code, 1);
  assert.match(badOracle.output, /Blockbook parity: mismatch/);
  assert.equal(noJWTLeak, true, 'Asset API authorization headers leaked to oracle');
  console.log('Local HTTP fixture: success, expected failures, and auth isolation verified.');
} finally {
  server.close();
}

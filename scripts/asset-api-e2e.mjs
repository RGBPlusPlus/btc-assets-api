import assert from 'node:assert/strict';
import { test } from 'node:test';

const GENESIS = {
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  testnet: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
  signet: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
};
const MAX_SATOSHI = 2_100_000_000_000_000;
const HASH = /^[a-f0-9]{64}$/;
const BTC_OUTPOINT = /^[a-f0-9]{64}:(0|[1-9]\d*)$/;
const CKB_HASH = /^0x[a-f0-9]{64}$/;
const HEX_INDEX = /^0x[0-9a-f]+$/;

function required(name) {
  const value = process.env[name]?.trim();
  assert(value, `Set ${name} before running the Asset API E2E suite`);
  return value;
}

function url(name, value) {
  const parsed = URL.canParse(value) && new URL(value);
  assert(
    parsed &&
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash,
    `${name} must be an HTTP(S) URL without credentials, query, or fragment`,
  );
  return parsed;
}

const assetURL = url('E2E_ASSET_API_URL', required('E2E_ASSET_API_URL'));
const asset = assetURL.href.replace(/\/$/, '');
const network = required('E2E_BTC_NETWORK');
assert(Object.hasOwn(GENESIS, network), 'E2E_BTC_NETWORK must be mainnet, testnet (Testnet3), or signet');
const address = encodeURIComponent(required('E2E_BTC_ADDRESS'));
const outpoint = required('E2E_BTC_OUTPOINT');
assert(BTC_OUTPOINT.test(outpoint), 'E2E_BTC_OUTPOINT must be txid:vout (decimal vout)');
const expectedValue = Number(required('E2E_BTC_VALUE_SATS'));
assert(
  Number.isSafeInteger(expectedValue) && expectedValue >= 0 && expectedValue <= MAX_SATOSHI,
  'E2E_BTC_VALUE_SATS must be an integer satoshi amount',
);
const minCount = Number(process.env.E2E_BTC_MIN_UTXOS?.trim() || 1);
assert(Number.isSafeInteger(minCount) && minCount >= 1, 'E2E_BTC_MIN_UTXOS must be a positive integer');

const unconfirmedOutpoint = process.env.E2E_BTC_UNCONFIRMED_OUTPOINT?.trim();
assert(
  !unconfirmedOutpoint || (BTC_OUTPOINT.test(unconfirmedOutpoint) && unconfirmedOutpoint !== outpoint),
  'E2E_BTC_UNCONFIRMED_OUTPOINT must be a different txid:vout (decimal vout) for the same address',
);

const jwt = process.env.E2E_ASSET_API_JWT;
const origin = process.env.E2E_ASSET_API_ORIGIN;
if (jwt) {
  assert(/^[\w.-]+$/.test(jwt), 'E2E_ASSET_API_JWT must be a compact JWT');
  assert(origin, 'Set E2E_ASSET_API_ORIGIN with E2E_ASSET_API_JWT');
  assert(
    assetURL.protocol === 'https:' || ['127.0.0.1', '[::1]'].includes(assetURL.hostname),
    'E2E_ASSET_API_JWT requires HTTPS or a literal loopback address (127.0.0.1 or ::1)',
  );
}
const headers = {
  ...(jwt && { Authorization: `Bearer ${jwt}` }),
  ...(origin && { Origin: url('E2E_ASSET_API_ORIGIN', origin).origin }),
};
const oracle =
  process.env.E2E_BLOCKBOOK_URL && url('E2E_BLOCKBOOK_URL', process.env.E2E_BLOCKBOOK_URL).href.replace(/\/$/, '');
function normalizeCellPoint(txHash, index) {
  if (typeof txHash !== 'string' || !CKB_HASH.test(txHash) || typeof index !== 'string' || !HEX_INDEX.test(index)) {
    return undefined;
  }
  return `${txHash}:0x${BigInt(index).toString(16)}`;
}

const configuredCell = process.env.E2E_RGBPP_OUTPOINT?.trim();
const [cellHash, cellIndex, extraCellPart] = configuredCell?.split(':') ?? [];
const assetCell = normalizeCellPoint(cellHash, cellIndex);
assert(
  !configuredCell || (assetCell !== undefined && extraCellPart === undefined),
  'E2E_RGBPP_OUTPOINT must be 0x<CKB tx hash>:0x<index>',
);

async function get(base, path, label, requestHeaders = {}) {
  let response;
  try {
    response = await fetch(base + path, {
      headers: requestHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`${label}: request failed, timed out, or redirected`);
  }
  assert.equal(response.status, 200, `${label}: expected HTTP 200`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: invalid JSON response`);
  }
}

const api = (path, label) => get(asset, path, label, headers);
const info = () => api('/bitcoin/v1/info', 'Asset API chain info');
const list = (confirmed, min) =>
  api(
    `/bitcoin/v1/address/${address}/unspent?no_cache=true&only_confirmed=${confirmed}${min === undefined ? '' : `&min_satoshi=${min}`}`,
    'Asset API unspent outputs',
  );

function normalize(rows, source, isBlockbook = false) {
  assert(Array.isArray(rows), `${source}: expected an array`);
  const result = new Map();
  for (const row of rows) {
    assert(row && typeof row.txid === 'string' && HASH.test(row.txid), `${source}: invalid txid`);
    assert(Number.isSafeInteger(row.vout) && row.vout >= 0 && row.vout <= 0xffffffff, `${source}: invalid vout`);
    const key = `${row.txid}:${row.vout}`;
    assert(!result.has(key), `${source}: duplicate outpoint ${key}`);
    let value = row.value;
    if (isBlockbook) {
      assert(typeof value === 'string' && /^\d+$/.test(value), `${source}: expected a satoshi string`);
      value = Number(value);
      assert(Number.isSafeInteger(row.confirmations) && row.confirmations >= 0, `${source}: invalid confirmations`);
    }
    assert(Number.isSafeInteger(value) && value >= 0 && value <= MAX_SATOSHI, `${source}: invalid satoshi value`);
    const confirmed = isBlockbook ? row.confirmations > 0 : row.status?.confirmed;
    assert.equal(typeof confirmed, 'boolean', `${source}: invalid confirmation status`);
    result.set(key, { value, confirmed });
  }
  return result;
}

function equal(left, right) {
  return (
    left.size === right.size &&
    [...left].every(([key, row]) => {
      const other = right.get(key);
      return other?.value === row.value && other.confirmed === row.confirmed;
    })
  );
}

function assertEqual(left, right, label) {
  for (const [key, row] of left) {
    assert.deepEqual(right.get(key), row, `${label}: mismatch at ${key}`);
  }
  assert.equal(right.size, left.size, `${label}: result contains extra outpoints`);
}

function blockbookStatusMismatch(status, tip) {
  if (status?.blockbook?.inSync !== true || status.blockbook.inSyncMempool !== true) {
    return 'Blockbook is not synced';
  }
  if (status.blockbook.bestHeight !== tip.blocks) {
    return 'Blockbook and Asset API heights differ; retry after sync';
  }
  if (status.backend?.bestBlockHash !== tip.bestblockhash) {
    return 'Blockbook and Asset API tips differ; retry after sync';
  }
}

async function stableView(check) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tip = await info();
    const first = normalize(await list(false), 'Asset API');
    const verify = await check(first, tip);
    const last = normalize(await list(false), 'Asset API');
    const finalTip = await info();
    if (tip.bestblockhash === finalTip.bestblockhash && equal(first, last)) {
      verify();
      return;
    }
  }
  assert.fail('The Bitcoin tip or fixture UTXOs changed during the checks; use a quiet fixture and retry');
}

test('Asset API is healthy and connected to the expected Bitcoin network', async () => {
  await api('/healthcheck', 'Asset API healthcheck');
  const chain = await info();
  assert.equal(chain.chain, network === 'mainnet' ? 'main' : 'test', 'unexpected chain family');
  assert(Number.isSafeInteger(chain.blocks) && chain.blocks > 0, 'invalid chain height');
  assert(typeof chain.bestblockhash === 'string' && HASH.test(chain.bestblockhash), 'invalid tip hash');
  const genesis = await api('/bitcoin/v1/block/height/0', 'Asset API genesis');
  assert.equal(genesis.hash, GENESIS[network], 'unexpected Bitcoin genesis hash');
});

test('Address UTXOs contain the known confirmed fixture and honor confirmation and value filters', async () => {
  await stableView(async (all) => {
    const confirmed = normalize(await list(true), 'Asset API confirmed');
    const inclusive = normalize(await list(false, expectedValue), 'Asset API inclusive minimum value');
    const exclusive = normalize(await list(false, expectedValue + 1), 'Asset API above fixture value');
    return () => {
      assert(all.size >= minCount, `expected at least ${minCount} UTXOs; got ${all.size}`);
      assert.deepEqual(
        all.get(outpoint),
        { value: expectedValue, confirmed: true },
        'known fixture UTXO is incorrect or missing',
      );
      assertEqual(new Map([...all].filter(([, row]) => row.confirmed)), confirmed, 'confirmed-only filter');
      assertEqual(
        new Map([...all].filter(([, row]) => row.value >= expectedValue)),
        inclusive,
        'inclusive minimum-value filter',
      );
      assertEqual(
        new Map([...all].filter(([, row]) => row.value > expectedValue)),
        exclusive,
        'above-fixture minimum-value filter',
      );
    };
  });
});

test(
  'Known unconfirmed output appears only in the unfiltered response',
  {
    skip: !unconfirmedOutpoint && 'set E2E_BTC_UNCONFIRMED_OUTPOINT',
  },
  async () => {
    await stableView(async (all) => {
      const confirmed = normalize(await list(true), 'Asset API confirmed');
      return () => {
        assert.equal(
          all.get(unconfirmedOutpoint)?.confirmed,
          false,
          'known unconfirmed output is missing or no longer in the mempool',
        );
        assert(!confirmed.has(unconfirmedOutpoint), 'confirmed-only filter returned the known unconfirmed output');
      };
    });
  },
);

test('Address UTXOs match the optional Blockbook oracle', { skip: !oracle && 'set E2E_BLOCKBOOK_URL' }, async () => {
  const genesis = await get(oracle, '/api/v2/block-index/0', 'Blockbook genesis');
  assert.equal(genesis.blockHash, GENESIS[network], 'Blockbook is on a different Bitcoin network');
  await stableView(async (all, tip) => {
    const statusMismatch = async () => blockbookStatusMismatch(await get(oracle, '/api/', 'Blockbook status'), tip);
    const indexedHash = () => get(oracle, `/api/v2/block-index/${tip.blocks}`, 'Blockbook indexed tip');
    // A lagging index may not serve the requested height. Report the status mismatch
    // without that lookup, but still let stableView retry if the Asset API view moved.
    const beforeMismatch = await statusMismatch();
    if (beforeMismatch) return () => assert.fail(beforeMismatch);
    const beforeIndexed = await indexedHash();
    const read = () => get(oracle, `/api/v2/utxo/${address}?confirmed=false`, 'Blockbook address UTXOs');
    const expected = normalize(await read(), 'Blockbook', true);
    const repeated = normalize(await read(), 'Blockbook', true);
    const afterMismatch = await statusMismatch();
    if (afterMismatch) return () => assert.fail(afterMismatch);
    const afterIndexed = await indexedHash();
    return () => {
      for (const indexed of [beforeIndexed, afterIndexed]) {
        assert.equal(indexed.blockHash, tip.bestblockhash, 'Blockbook indexed block differs from the Asset API tip');
      }
      assert(equal(expected, repeated), 'Blockbook fixture changed during comparison; retry with a quiet fixture');
      assertEqual(expected, all, 'Blockbook parity');
    };
  });
});

test('RGB++ assets include the optional known CKB cell', { skip: !assetCell && 'set E2E_RGBPP_OUTPOINT' }, async () => {
  const cells = await api(`/rgbpp/v1/address/${address}/assets?no_cache=true`, 'RGB++ assets');
  assert(Array.isArray(cells), 'RGB++ assets: expected an array');
  assert(
    cells.some((cell) => {
      const point = cell?.outPoint;
      return normalizeCellPoint(point?.txHash, point?.index) === assetCell;
    }),
    'known RGB++ cell is missing',
  );
});

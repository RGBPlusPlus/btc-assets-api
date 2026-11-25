## Bitcoin/RGB++ Assets API

A service for Retrieving BTC/RGB++ information/assets and processing transactions with these assets

### Features

- Retrieving Blockchain Information such as Bitcoin chain info, blocks, headers, transactions, addresses and RGB++ assets
- Transaction Handling by posting transactions to the /bitcoin/v1/transaction or /rgbpp/v1/transaction/ckb-tx endpoint
- RGB++ CKB transaction Queue simplifies the RGB++ assets workflows by some cron jobs

## Get started

We provide APIs for Testnet3 for public use.

**Testnet3**
- API Base URL: 
  1. `https://api-testnet.rgbpp.com`
     - Swagger Documentation: https://api-testnet.rgbpp.com/docs
  2. `https://api.testnet.rgbpp.io`
     - Swagger Documentation: https://api.testnet.rgbpp.io/docs

For mainnet, API is currently limited to verified apps only.
You can also check the [Deployment](#Deployment) section to deploy your own.

### Get an access token

#### Testnet3 & Signet

**No access token required** - You can directly access all API endpoints on Testnet3 and signet environments without authentication.

#### Mainnet

The mainnet is currently limited to verified apps only.

When your app development is ready on testnet, and requires a mainnet access token,
please email us at [buidl@rgbpp.com](mailto:buidl@rgbpp.com) to request a mainnet JWT token.

In the email, please provide the following information about your app:

- `name`: Your app name, e.g. "rgbpp-app"
- `domain`: Your app domain, e.g. "rgbpp.app" (without protocol prefix and port suffix)

### Deployment

#### Requirements

- [mempool.space](https://mempool.space/docs) or [mempool/electrs](https://github.com/mempool/electrs): provides data about the Bitcoin network.
  - We can use either of them as data provider
  - Or use both, designating one as the primary provider and the other as the fallback
- [ckb-cell/ckb-bitcoin-spv-service](https://github.com/ckb-cell/ckb-bitcoin-spv-service): CKB Bitcoin SPV Service for Bitcoin block header verification
  - **Testnet3**: Public SPV service available at `https://spv-testnet.rgbpp.com`
  - **Mainnet**: Please email us at [buidl@rgbpp.com](mailto:buidl@rgbpp.com) for more information

#### Configuration

Copy the `.env.example` file to `.env`:

```bash
cp .env.example .env
```

Update the configuration values:

```env
# Bitcoin network, testnet by default
NETWORK=testnet

# Set /token/generate default domain param
# DOMAIN=localhost

# Trust all proxies (true) or do not trust any proxies (false)
# TRUST_PROXY=true

REDIS_URL=redis://redis:6379

# Sentry DSN URL for error tracking and cron monitoring
SENTRY_DSN_URL=<sentry_dsn_url>
# SENTRY_TRACES_SAMPLE_RATE=0.5
# SENTRY_PROFILES_SAMPLE_RATE=0.5

# Per-IP requests per minute, 100 by default. Set to 0 to disable application rate limiting.
RATE_LIMIT_PER_MINUTE=100
# The blocklist of IP addresses that are denied access to the API.
# IP_BLOCKLIST=

# Production: set both administrator credentials before exposing the service.
# These are commented placeholders, not defaults.
# ADMIN_USERNAME=<admin_username>
# ADMIN_PASSWORD=<admin_password>

# JWT_SECRET is used to sign the JWT token for authentication
JWT_SECRET=<your_secret>
# Set to false only if public Bitcoin and RGB++ read and write routes may be anonymous.
PUBLIC_API_JWT_REQUIRED=true
# JWT token denylist
# JWT_DENYLIST=

# Bitcoin data provider: electrs, mempool, or blockbook (requires Bitcoin Core RPC)
# use electrs as default, mempool as fallback
# change to mempool if you want to use mempool.space as default and electrs as fallback
BITCOIN_DATA_PROVIDER=electrs
# Bitcoin Mempool.space API URL
# optinal when BITCOIN_DATA_PROVIDER=electrs
BITCOIN_MEMPOOL_SPACE_API_URL=https://mempool.space
# Electrs API URL
# optinal when BITCOIN_DATA_PROVIDER=mempool
BITCOIN_ELECTRS_API_URL=<http://electrs:3002>
# Optional: use a synced Blockbook instance only for Bitcoin address UTXOs
# BITCOIN_BLOCKBOOK_API_URL=http://blockbook:19130

# SPV Service URL
BITCOIN_SPV_SERVICE_URL=<http://spv:3001>

# CKB RPC URL
CKB_RPC_URL=https://testnet.ckb.dev/rpc

# Paymaster private key for CKB, used to sign the transaction
PAYMASTER_PRIVATE_KEY=
# Paymaster cell capacity in shannons
PAYMASTER_CELL_CAPACITY=31600000000
# Check the paymaster BTC UTXO when processing rgb++ ckb transaction
PAYMASTER_RECEIVE_UTXO_CHECK=false
# Paymaster bitcoin address, used to receive BTC from users
PAYMASTER_RECEIVE_BTC_ADDRESS=<paymaster_btc_address>
# Paymaster receives BTC UTXO size in sats
PAYMASTER_BTC_CONTAINER_FEE_SATS=7000

# BTCTimeLock cell unlock cron job schedule, default is every 5 minutes
UNLOCKER_CRON_SCHEDULE='*/5 * * * *'
# BTCTimeLock cell unlock batch size
UNLOCKER_CELL_BATCH_SIZE=100

# RGB++ CKB transaction Queue cron job delay in milliseconds
# the /rgbpp/v1/transaction/ckb-tx endpoint is called, the transaction will be added to the queue
TRANSACTION_QUEUE_JOB_DELAY=120000
# RGB++ CKB transaction Queue cron job attempts
TRANSACTION_QUEUE_JOB_ATTEMPTS=6
# Pay fee for transaction with pool reject by min fee rate, false by default
TRANSACTION_PAY_FOR_MIN_FEE_RATE_REJECT=false
```

### Self-host with Blockbook and Bitcoin Core

Use `blockbook` to run without Electrs or Mempool.space. Example for Bitcoin Testnet3:

```dotenv
NETWORK=testnet
BITCOIN_DATA_PROVIDER=blockbook
BITCOIN_BLOCKBOOK_API_URL=http://blockbook:19130
BITCOIN_CORE_RPC_URL=http://bitcoind:18332
BITCOIN_CORE_RPC_USERNAME=<rpc_user>
BITCOIN_CORE_RPC_PASSWORD=<rpc_password>
```

Adjust the ports to match your deployment. Use the Blockbook service base URL without `/api/v2`. Use synced Bitcoin Core 31+ with `txindex=1`, `txospenderindex=1`, and `prune=0`, and a fully indexed Blockbook with mempool indexing. Point Blockbook and the Asset API to the same Core when possible. The API checks that both services are on the configured network at startup. Keep RPC private; set both credentials, or omit both only when a private proxy authenticates upstream. `/healthcheck` probes Core's chain and both indexes and Blockbook's chain and mempool sync.

Blockbook serves address UTXOs and indexes address history. Core supplies transaction details, fees, canonical block and header data for SPV, exact confirmed and mempool spends, and broadcast. Core needs the additional spender index for exact spending outpoints, not a separate Bitcoin node. This mode does not use legacy Bitcoin providers or additional Electrs broadcast targets. The separate `BITCOIN_SPV_SERVICE_URL`, Redis, and CKB requirements are unchanged.

Address history accepts both confirmed and pending transaction cursors. Each page returns up to 50 pending transactions first. Once the pending rows are exhausted, that same page can include up to 25 confirmed transactions. If the API detects a change to pending history while assembling a page, it can return HTTP 503 with instructions to restart from the first page. A change detected while reading confirmed history can instead return a generic HTTP 503. A txid cursor does not record its previous confirmation state, so also restart if a pending cursor confirms between page requests and you need to include any still-pending rows.

Blockbook releases that cap pending txids to a single REST page, such as v0.6.0, cannot enumerate beyond 1,000 pending entries. A continuation that needs the hidden entries returns HTTP 503 instead of silently skipping them.

To override only UTXOs and keep the rest on Electrs or Mempool, keep the existing `BITCOIN_DATA_PROVIDER` and set only `BITCOIN_BLOCKBOOK_API_URL`. In both modes, a live UTXO query returns the entire list including mempool changes; it is not paginated and omits optional `block_hash` and `block_time`. Sync jobs refresh directly from Blockbook rather than address history; sync jobs and snapshots are separate from the legacy backend and other Blockbook endpoints. Use `no_cache=true` to test a live read.

Public Bitcoin and RGB++ routes require JWTs by default (except in development).
Setting `PUBLIC_API_JWT_REQUIRED=false` makes the registered `/bitcoin/v1`,
`/rgbpp/v1`, and `/rgbpp/v2` operations anonymous, including transaction
broadcast and submission. These operations ignore any supplied Authorization
header and allow cross-origin browser access. Keep setting `JWT_SECRET` for token signing.

**Production token issuance.** Before exposing a production deployment, set both
`ADMIN_USERNAME` and `ADMIN_PASSWORD` using your deployment's secret configuration.
The token issuer needs both values to restrict issuance to administrators in
`NODE_ENV=production`. This is independent of Bitcoin network selection and of
`PUBLIC_API_JWT_REQUIRED`, which controls authentication on the public Bitcoin
and RGB++ routes.

**Internal administration.** Internal administrative routes are disabled unless both `ADMIN_USERNAME` and
`ADMIN_PASSWORD` are configured. When enabled, they require HTTP Basic
authentication in every environment, independently of public JWT settings.
Keep these routes on a private network or restrict them at the gateway, and only
send admin credentials over HTTPS (or local loopback). If a production deployment
does not need remote administration, block internal administrative routes at the
gateway rather than removing the credentials used by the token issuer.

For a restricted deployment, enforce its access policy at the gateway or on a
private network. If the deployment should only serve reads, explicitly allowlist
the read operations at the gateway. Keep IP rate limits in place and monitor
transaction queues and paymaster usage.

#### Docker

Use the provided `docker-compose.yml` file to run the service:

```bash
docker-compose up
```

After the service is running, you can access the API documentation at `http://localhost:3000/docs`

## Tests

Run `pnpm test:unit` for the offline unit and mock suites used by CI. No services or secrets are required.
The full Vitest suite (`pnpm test`) also includes integration tests that need Redis and configured backends.
Use a disposable Redis instance: test teardown flushes it.

## End-to-end tests

Run these read-only HTTP checks against a **running Asset API** using any supported Bitcoin backend. They do not start the server, broadcast transactions, flush Redis, or run as part of the default unit tests. The API can still perform its normal cache and queue updates during these reads.

Use Node.js 20 or newer and a quiet address with a known confirmed, currently unspent output. Verify the fixture outpoint and amount independently (for example, with Bitcoin Core's `gettxout` for that outpoint); do not copy them from the API under test.

```sh
export E2E_ASSET_API_URL=http://localhost:3000
export E2E_BTC_NETWORK=testnet # mainnet, testnet (Testnet3), or signet
export E2E_BTC_ADDRESS='<BTC address>'
export E2E_BTC_OUTPOINT='<txid>:<decimal vout>'
export E2E_BTC_VALUE_SATS='<amount in satoshis>'
pnpm test:e2e
```

The suite checks service health, the Bitcoin genesis and tip response, the confirmed fixture UTXO, and inclusive/exclusive value filtering. It bypasses the address UTXO cache and checks that the Bitcoin tip and the address's UTXOs are stable across the filter requests.

Optional checks and configuration:

- For an authenticated API, supply `E2E_ASSET_API_JWT` securely in your local environment and set `E2E_ASSET_API_ORIGIN` to the origin matching the JWT audience. Bearer authentication requires HTTPS or literal loopback (`127.0.0.1` or `::1`); redirects are not followed.
- Set `E2E_BTC_UNCONFIRMED_OUTPOINT=<txid>:<decimal vout>` to verify that a separately known mempool output at the same address is returned only without the confirmation filter. Otherwise this check is skipped.
- Set `E2E_BTC_MIN_UTXOS=501` and use a fixture known to have at least 501 current UTXOs to detect truncation. Use an ordinary fixture on backends that enforce an address limit.
- Set `E2E_BLOCKBOOK_URL` to the base URL of a synced Blockbook instance on the same chain to compare the exact outpoints, satoshi values, and confirmed/mempool status. The oracle's indexed tip must match the Asset API, and the fixture should not be changing in the mempool. If the API uses this same Blockbook instance, the comparison verifies mapping, not correctness of the index itself.
- For an RGB++ fixture, set `E2E_RGBPP_OUTPOINT=0x<CKB tx hash>:0x<index>` to check that the corresponding live cell is returned from the address assets endpoint. Use a small fixture here to avoid expensive CKB lookups.

Use `pnpm test:e2e:fixture` to exercise the runner against a disposable loopback fixture without a running Asset API.

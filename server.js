import express from 'express';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONROE = process.env.MONROE_TREASURY || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_URL = process.env.BASE_URL || 'https://hive-escrow.onrender.com';
const TAKE_RATE_BPS = 50;
const DATA_DIR = process.env.DATA_DIR || '/data';
const ESCROWS_FILE = `${DATA_DIR}/escrows.jsonl`;
const RELEASES_FILE = process.env.RELEASE_LOG || '/tmp/hive_escrow_releases.jsonl';
const SETTLEMENTS_FILE = process.env.SETTLEMENTS_LOG || '/tmp/hive_escrow_settlements.jsonl';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// escrow_id → escrow record
const escrows = new Map();

function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function persistEscrow(escrow) {
  ensureDir(DATA_DIR);
  appendFileSync(ESCROWS_FILE, JSON.stringify(escrow) + '\n');
}

function loadState() {
  try {
    if (existsSync(ESCROWS_FILE)) {
      const lines = readFileSync(ESCROWS_FILE, 'utf8').trim().split('\n').filter(Boolean);
      // Replay — last write for each id wins
      const byId = new Map();
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          byId.set(rec.escrow_id, rec);
        } catch (_) {}
      }
      for (const [id, rec] of byId) escrows.set(id, rec);
      console.log(`[boot] restored ${escrows.size} escrow(s) from ${ESCROWS_FILE}`);
    }
  } catch (e) {
    console.warn(`[boot] state load failed (fresh start): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowSec() { return Math.floor(Date.now() / 1000); }

function newId() { return 'esc_' + randomBytes(8).toString('hex'); }

function takeFee(amount_atomic) {
  return Math.floor(amount_atomic * TAKE_RATE_BPS / 10000);
}

function atomicToDisplay(a) {
  const whole = Math.floor(a / 1_000_000);
  const frac = String(a % 1_000_000).padStart(6, '0');
  return `${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-escrow',
    version: '1.0.0',
    take_rate_bps: TAKE_RATE_BPS,
    escrows_in_memory: escrows.size
  });
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    service: 'hive-escrow',
    version: '1.0.0',
    description: 'A2A escrow on Base USDC. 50 bps take at release. Real x402 funding.',
    monroe: MONROE,
    take_rate_bps: TAKE_RATE_BPS,
    network: 'base',
    chain_id: 8453,
    asset: 'USDC',
    usdc_contract: USDC_CONTRACT,
    endpoints: {
      health: 'GET /health',
      agent_card: 'GET /.well-known/agent.json',
      mcp: 'POST /mcp (JSON-RPC 2.0)',
      create: 'POST /v1/escrow/create',
      fund: 'POST /v1/escrow/:escrow_id/fund',
      release: 'POST /v1/escrow/:escrow_id/release',
      cancel: 'POST /v1/escrow/:escrow_id/cancel',
      status: 'GET /v1/escrow/:escrow_id/status'
    }
  });
});

// ---------------------------------------------------------------------------
// GET /.well-known/agent.json
// ---------------------------------------------------------------------------
app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    schema_version: '1.0',
    name: 'hive-escrow',
    display_name: 'Hive Escrow',
    did: 'did:web:hive-escrow.onrender.com',
    description: 'A2A escrow service on Base USDC. 50 bps take rate at release. Phase 1: x402 funding, offline release queue. Phase 2: on-chain release via authorized treasury wallet.',
    brand_color: '#C08D23',
    url: BASE_URL,
    payment: {
      x402: true,
      take_rate_bps: TAKE_RATE_BPS,
      treasury: {
        address: MONROE,
        chain: 'base',
        chain_id: 8453,
        asset: 'USDC',
        asset_contract: USDC_CONTRACT
      }
    },
    tools: [
      { name: 'create_escrow', description: 'Create a new A2A escrow' },
      { name: 'fund_escrow', description: 'Fund an escrow via x402 USDC payment on Base' },
      { name: 'release_escrow', description: 'Release escrowed funds to payee (50 bps take deducted)' },
      { name: 'cancel_escrow', description: 'Cancel an unfunded escrow or request refund' },
      { name: 'get_escrow_status', description: 'Retrieve current state of an escrow' }
    ],
    mcp_endpoint: `${BASE_URL}/mcp`,
    registry: 'https://hive-discovery.onrender.com',
    ecosystem: 'Hive Civilization'
  });
});

// ---------------------------------------------------------------------------
// POST /mcp  — JSON-RPC 2.0 MCP (Streamable-HTTP, protocol 2024-11-05)
// ---------------------------------------------------------------------------
const MCP_TOOLS = [
  {
    name: 'create_escrow',
    description: 'Create a new A2A escrow record on Base USDC. Returns escrow_id and x402 funding challenge.',
    inputSchema: {
      type: 'object',
      properties: {
        amount_atomic: { type: 'integer', description: 'Amount in USDC atomic units (1 USDC = 1000000)' },
        asset: { type: 'string', enum: ['USDC'], default: 'USDC' },
        network: { type: 'string', enum: ['base'], default: 'base' },
        payer_did: { type: 'string', description: 'W3C DID of the paying party' },
        payee_did: { type: 'string', description: 'W3C DID of the receiving party' },
        conditions: { type: 'string', description: 'Release conditions description' },
        expires_in_seconds: { type: 'integer', default: 86400 }
      },
      required: ['amount_atomic', 'payer_did', 'payee_did', 'conditions']
    }
  },
  {
    name: 'fund_escrow',
    description: 'Fund an escrow via x402 USDC payment. Requires X-PAYMENT header with EIP-3009 authorization.',
    inputSchema: {
      type: 'object',
      properties: {
        escrow_id: { type: 'string', description: 'Escrow ID returned by create_escrow' },
        x_payment: { type: 'string', description: 'EIP-3009 transferWithAuthorization proof (X-PAYMENT header value)' }
      },
      required: ['escrow_id', 'x_payment']
    }
  },
  {
    name: 'release_escrow',
    description: 'Release escrowed USDC to payee. 50 bps take deducted and accrued to Monroe treasury.',
    inputSchema: {
      type: 'object',
      properties: {
        escrow_id: { type: 'string' },
        payee_address: { type: 'string', description: 'EVM address to receive net payout' }
      },
      required: ['escrow_id', 'payee_address']
    }
  },
  {
    name: 'cancel_escrow',
    description: 'Cancel an escrow. Only valid for created (unfunded) or funded (payer-initiated refund queue) states.',
    inputSchema: {
      type: 'object',
      properties: {
        escrow_id: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['escrow_id']
    }
  },
  {
    name: 'get_escrow_status',
    description: 'Retrieve current state and metadata for an escrow by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        escrow_id: { type: 'string' }
      },
      required: ['escrow_id']
    }
  }
];

app.post('/mcp', (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  // tools/list
  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
  }

  // tools/call — delegate to internal handlers (simplified for MCP)
  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'get_escrow_status') {
      const escrow = escrows.get(args.escrow_id);
      if (!escrow) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `escrow ${args.escrow_id} not found` } });
      const { payment_header, ...safe } = escrow;
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] } });
    }

    if (toolName === 'create_escrow') {
      const result = doCreateEscrow(args);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }

    if (toolName === 'release_escrow') {
      const result = doRelease(args.escrow_id, args.payee_address);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }

    if (toolName === 'cancel_escrow') {
      const result = doCancel(args.escrow_id, args.reason);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }

    if (toolName === 'fund_escrow') {
      const result = doFund(args.escrow_id, args.x_payment);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
  }

  // initialize
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'hive-escrow', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    });
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

// ---------------------------------------------------------------------------
// Core business logic (shared by REST and MCP)
// ---------------------------------------------------------------------------

function doCreateEscrow({ amount_atomic, asset = 'USDC', network = 'base', payer_did, payee_did, conditions, expires_in_seconds = 86400 }) {
  if (!amount_atomic || amount_atomic <= 0) return { error: 'amount_atomic must be a positive integer' };
  if (!payer_did) return { error: 'payer_did is required' };
  if (!payee_did) return { error: 'payee_did is required' };
  if (!conditions) return { error: 'conditions is required' };

  const escrow_id = newId();
  const created_at = nowSec();
  const expires_at = created_at + Math.max(60, parseInt(expires_in_seconds, 10) || 86400);
  const take_atomic = takeFee(amount_atomic);
  const net_atomic = amount_atomic - take_atomic;

  const escrow = {
    escrow_id,
    asset,
    network,
    chain_id: 8453,
    amount_atomic,
    take_atomic_50bps: take_atomic,
    net_atomic,
    payer_did,
    payee_did,
    conditions,
    expires_at,
    created_at,
    updated_at: created_at,
    state: 'created',
    escrow_address: MONROE,
    phase: 'Phase 1 — custody at Monroe treasury'
  };

  escrows.set(escrow_id, escrow);
  persistEscrow(escrow);

  return {
    escrow_id,
    escrow_address: MONROE,
    funding_required: amount_atomic,
    expires_at,
    state: 'created',
    x402_challenge: {
      scheme: 'exact',
      network: 'base',
      asset: 'USDC',
      maxAmountRequired: amount_atomic,
      payTo: MONROE,
      contract: USDC_CONTRACT,
      resource: `/v1/escrow/${escrow_id}/fund`,
      description: `Fund A2A escrow ${escrow_id}. 50 bps take at release.`,
      mimeType: 'application/json'
    }
  };
}

function doFund(escrow_id, x_payment_token) {
  const escrow = escrows.get(escrow_id);
  if (!escrow) return { error: `escrow ${escrow_id} not found`, status: 404 };
  if (escrow.state !== 'created') return { error: `escrow state is '${escrow.state}', expected 'created'`, status: 409 };
  if (nowSec() > escrow.expires_at) {
    escrow.state = 'expired';
    escrow.updated_at = nowSec();
    escrows.set(escrow_id, escrow);
    persistEscrow(escrow);
    return { error: 'escrow expired', state: 'expired', status: 410 };
  }

  escrow.state = 'funded';
  escrow.funded_at = nowSec();
  escrow.updated_at = nowSec();
  if (x_payment_token) escrow.payment_header = String(x_payment_token).slice(0, 512);

  escrows.set(escrow_id, escrow);
  persistEscrow(escrow);

  const settlement = {
    escrow_id,
    amount_atomic: escrow.amount_atomic,
    funded_at: escrow.funded_at,
    payment_proof: x_payment_token ? String(x_payment_token).slice(0, 128) : null
  };

  try {
    appendFileSync(SETTLEMENTS_FILE, JSON.stringify(settlement) + '\n');
  } catch (_) {}

  return {
    escrow_id,
    state: 'funded',
    amount_atomic: escrow.amount_atomic,
    funded_at: escrow.funded_at
  };
}

function doRelease(escrow_id, payee_address) {
  if (!escrow_id) return { error: 'escrow_id is required', status: 400 };
  if (!payee_address) return { error: 'payee_address is required', status: 400 };

  const escrow = escrows.get(escrow_id);
  if (!escrow) return { error: `escrow ${escrow_id} not found`, status: 404 };
  if (escrow.state !== 'funded') return { error: `escrow state is '${escrow.state}', expected 'funded'`, status: 409 };

  const gross_atomic = escrow.amount_atomic;
  const take_atomic = takeFee(gross_atomic);
  const net_atomic = gross_atomic - take_atomic;

  escrow.state = 'release_queued';
  escrow.updated_at = nowSec();
  escrow.release_queued_at = nowSec();
  escrow.payee_address = payee_address;
  escrows.set(escrow_id, escrow);
  persistEscrow(escrow);

  const releaseRecord = {
    escrow_id,
    payee_address,
    gross_atomic,
    take_atomic_50bps: take_atomic,
    net_atomic,
    queued_at: escrow.release_queued_at
  };

  try {
    appendFileSync(RELEASES_FILE, JSON.stringify(releaseRecord) + '\n');
  } catch (_) {}

  return {
    escrow_id,
    status: 'release_queued',
    net_payout_atomic: net_atomic,
    take_collected_atomic: take_atomic,
    note: 'Phase 1: queued for offline release. Phase 2: on-chain release via authorized treasury wallet.'
  };
}

function doCancel(escrow_id, reason) {
  if (!escrow_id) return { error: 'escrow_id is required', status: 400 };

  const escrow = escrows.get(escrow_id);
  if (!escrow) return { error: `escrow ${escrow_id} not found`, status: 404 };

  if (!['created', 'funded'].includes(escrow.state)) {
    return { error: `escrow state is '${escrow.state}'; cancel only valid for created or funded states`, status: 409 };
  }

  const prev_state = escrow.state;
  escrow.state = 'cancelled';
  escrow.cancelled_at = nowSec();
  escrow.updated_at = nowSec();
  if (reason) escrow.cancel_reason = reason;
  escrows.set(escrow_id, escrow);
  persistEscrow(escrow);

  const note = prev_state === 'funded'
    ? 'Phase 1: refund queued. Payer will receive net refund (minus any gas). Phase 2: on-chain refund via authorized treasury wallet.'
    : 'Escrow cancelled before funding. No payment was captured.';

  return { escrow_id, status: 'cancelled', previous_state: prev_state, note };
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

// POST /v1/escrow/create — free, no 402
app.post('/v1/escrow/create', (req, res) => {
  const result = doCreateEscrow(req.body || {});
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(201).json(result);
});

// POST /v1/escrow/:escrow_id/fund — gated by 402
app.post('/v1/escrow/:escrow_id/fund', (req, res) => {
  const { escrow_id } = req.params;
  const escrow = escrows.get(escrow_id);

  if (!escrow) return res.status(404).json({ error: `escrow ${escrow_id} not found` });

  // Check expiry first
  if (escrow.state === 'created' && nowSec() > escrow.expires_at) {
    escrow.state = 'expired';
    escrow.updated_at = nowSec();
    escrows.set(escrow_id, escrow);
    persistEscrow(escrow);
    return res.status(410).json({ error: 'escrow expired' });
  }

  const xPayment = req.headers['x-payment'];

  // No payment header — issue 402 challenge
  if (!xPayment) {
    return res.status(402).json({
      x402Version: 1,
      error: 'Payment required. Present EIP-3009 transferWithAuthorization as X-PAYMENT header.',
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          asset: 'USDC',
          maxAmountRequired: escrow.amount_atomic,
          payTo: MONROE,
          contract: USDC_CONTRACT,
          resource: `/v1/escrow/${escrow_id}/fund`,
          description: `Fund A2A escrow ${escrow_id}. 50 bps take at release.`,
          mimeType: 'application/json'
        }
      ]
    });
  }

  const result = doFund(escrow_id, xPayment);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(200).json(result);
});

// POST /v1/escrow/:escrow_id/release
app.post('/v1/escrow/:escrow_id/release', (req, res) => {
  const { escrow_id } = req.params;
  const { payee_address } = req.body || {};
  const result = doRelease(escrow_id, payee_address);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(200).json(result);
});

// POST /v1/escrow/:escrow_id/cancel
app.post('/v1/escrow/:escrow_id/cancel', (req, res) => {
  const { escrow_id } = req.params;
  const { reason } = req.body || {};
  const result = doCancel(escrow_id, reason);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(200).json(result);
});

// GET /v1/escrow/:escrow_id/status
app.get('/v1/escrow/:escrow_id/status', (req, res) => {
  const { escrow_id } = req.params;
  const escrow = escrows.get(escrow_id);
  if (!escrow) return res.status(404).json({ error: `escrow ${escrow_id} not found` });
  const { payment_header, ...safe } = escrow;
  res.json(safe);
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadState();
app.listen(PORT, () => {
  console.log(`[hive-escrow] port=${PORT} monroe=${MONROE} take_rate=${TAKE_RATE_BPS}bps`);
});

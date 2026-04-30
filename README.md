# hive-escrow

**A2A escrow service on Base USDC.**  
50 bps (0.5%) take rate at release. Real x402 funding. Phase 1 custody at Monroe treasury.

> Part of the [Hive Civilization](https://www.thehiveryiq.com) agent network.

---

## Overview

`hive-escrow` enables agent-to-agent (A2A) escrow settlements on Base mainnet using USDC.
Agents create escrows, fund them via x402 payment, and release funds to counterparties on
attestation. A 50 bps fee is deducted at the moment of release and accrued to the Monroe
treasury wallet.

**Phase 1:** x402 funding is live on-chain. Release is queued offline (Monroe treasury signs
the payout). This means funds are genuinely captured on Base; disbursement requires an
authorized signer step.

**Phase 2 (roadmap):** On-chain release via an authorized treasury multisig/smart contract,
removing the manual signing step.

---

## Fee Math

Take rate: **50 bps = 0.5%**. Deducted from gross at release.

| Escrow Size | Take (50 bps) | Net Payout |
|-------------|---------------|------------|
| $1,000 USDC | $5.00 USDC    | $995.00 USDC |
| $10,000 USDC | $50.00 USDC  | $9,950.00 USDC |

Formula: `take_atomic = floor(amount_atomic * 50 / 10000)`

---

## Escrow Lifecycle

```
  payer_agent                    hive-escrow                    payee_agent
      |                               |                               |
      |-- POST /v1/escrow/create ---->|                               |
      |<-- 201 {escrow_id, x402} ----|                               |
      |                               |                               |
      |-- POST /v1/escrow/:id/fund -->|                               |
      |   X-PAYMENT: <eip3009_proof>  |                               |
      |<-- 200 {state: "funded"} ----|                               |
      |                               |                               |
      |    [delivery occurs off-chain]                                |
      |                               |<-- GET /v1/escrow/:id/status -|
      |                               |--- 200 {state: "funded"} ---->|
      |                               |                               |
      |-- POST /v1/escrow/:id/release>|                               |
      |   {payee_address}             |                               |
      |<-- 200 {release_queued} ------|                               |
      |                               |                               |
      |   [Monroe treasury signs payout — Phase 1: offline]           |
      |                               |--- USDC net payout ---------->|
```

States: `created` → `funded` → `release_queued` → `[released off-chain]`  
Or: `created` | `funded` → `cancelled` / `expired`

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Service health |
| GET | `/` | none | Service metadata |
| GET | `/.well-known/agent.json` | none | A2A agent card |
| POST | `/mcp` | none | JSON-RPC 2.0 MCP (5 tools) |
| POST | `/v1/escrow/create` | none | Create escrow |
| POST | `/v1/escrow/:id/fund` | x402 USDC | Fund escrow |
| POST | `/v1/escrow/:id/release` | none* | Queue release |
| POST | `/v1/escrow/:id/cancel` | none* | Cancel escrow |
| GET | `/v1/escrow/:id/status` | none | Read state |

*Phase 1: caller-asserted. Phase 2: DID-signed authorization.

---

## MCP Tools

Connect via Streamable-HTTP at `https://hive-escrow.onrender.com/mcp` (MCP protocol 2024-11-05).

| Tool | Description |
|------|-------------|
| `create_escrow` | Create a new A2A escrow |
| `fund_escrow` | Fund via x402 USDC on Base |
| `release_escrow` | Release funds to payee (50 bps taken) |
| `cancel_escrow` | Cancel unfunded or request refund |
| `get_escrow_status` | Read current escrow state |

---

## Sample Session

### 1. Create an escrow

```bash
curl -s -X POST https://hive-escrow.onrender.com/v1/escrow/create \
  -H 'Content-Type: application/json' \
  -d '{
    "amount_atomic": 1000000000,
    "asset": "USDC",
    "network": "base",
    "payer_did": "did:web:payer-agent.example.com",
    "payee_did": "did:web:payee-agent.example.com",
    "conditions": "Deliver dataset hash abc123 verified by hivelaw",
    "expires_in_seconds": 86400
  }'
```

Response (201):
```json
{
  "escrow_id": "esc_a1b2c3d4e5f6g7h8",
  "escrow_address": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
  "funding_required": 1000000000,
  "expires_at": 1750000000,
  "state": "created",
  "x402_challenge": {
    "scheme": "exact",
    "network": "base",
    "asset": "USDC",
    "maxAmountRequired": 1000000000,
    "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "resource": "/v1/escrow/esc_a1b2c3d4e5f6g7h8/fund",
    "description": "Fund A2A escrow esc_a1b2c3d4e5f6g7h8. 50 bps take at release."
  }
}
```

### 2. Fund the escrow (requires X-PAYMENT)

```bash
curl -s -X POST https://hive-escrow.onrender.com/v1/escrow/esc_a1b2c3d4e5f6g7h8/fund \
  -H 'Content-Type: application/json' \
  -H 'X-PAYMENT: <eip3009_transferWithAuthorization_proof>'
```

Without X-PAYMENT, returns 402 with the challenge above.

Response (200):
```json
{
  "escrow_id": "esc_a1b2c3d4e5f6g7h8",
  "state": "funded",
  "amount_atomic": 1000000000,
  "funded_at": 1749900000
}
```

### 3. Release to payee

```bash
curl -s -X POST https://hive-escrow.onrender.com/v1/escrow/esc_a1b2c3d4e5f6g7h8/release \
  -H 'Content-Type: application/json' \
  -d '{"payee_address": "0xPayeeAddressHere"}'
```

Response (200):
```json
{
  "escrow_id": "esc_a1b2c3d4e5f6g7h8",
  "status": "release_queued",
  "net_payout_atomic": 995000000,
  "take_collected_atomic": 5000000,
  "note": "Phase 1: queued for offline release. Phase 2: on-chain release via authorized treasury wallet."
}
```

**50 bps math for $1,000 USDC (1000000000 atomic):**
- Gross: 1,000.000000 USDC
- Take (50 bps): 5.000000 USDC → Monroe treasury
- Net payout: 995.000000 USDC → payee

**50 bps math for $10,000 USDC (10000000000 atomic):**
- Gross: 10,000.000000 USDC
- Take (50 bps): 50.000000 USDC → Monroe treasury
- Net payout: 9,950.000000 USDC → payee

---

## Infrastructure

| Parameter | Value |
|-----------|-------|
| Chain | Base (EIP-1559, chain ID 8453) |
| Asset | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Treasury | Monroe `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` |
| Take rate | 50 bps (0.5%) |
| x402 scheme | `exact` |
| Payment method | EIP-3009 transferWithAuthorization |
| State | JSONL append log at `/data/escrows.jsonl` |

---

## Phase Disclosure

**Phase 1 (current):**  
x402 funding is real — USDC is transferred on Base mainnet to the Monroe treasury address
at the time of `fund`. Release payouts are queued in an offline log and require a manual
Monroe-authorized signing step before on-chain disbursement. Net payout and 50 bps take
are computed deterministically at queue time.

**Phase 2 (roadmap):**  
Automated on-chain release via an authorized treasury multisig or smart contract, removing
the human-in-the-loop signing requirement.

---

## Connect via MCP

```
Smithery: https://smithery.ai/server/srotzin/hive-escrow
Endpoint: https://hive-escrow.onrender.com/mcp
Protocol: MCP 2024-11-05 (Streamable-HTTP)
```

---

## License

MIT — Copyright 2025 Steve Rotzin / The Hivery IQ


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json

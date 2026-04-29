# v1.0.0 — Hive Escrow MCP Server

**Release date:** 2025-06-14  
**Repo:** https://github.com/srotzin/hive-escrow  
**Backend:** https://hive-escrow.onrender.com

---

## What Ships

`hive-escrow` is an A2A escrow service on Base USDC. Agents create, fund, and release
escrows with real x402 payment gating. 50 bps (0.5%) is deducted at release and accrued
to the Monroe treasury.

---

## MCP Tools (5)

| Tool | Description |
|------|-------------|
| `create_escrow` | Create a new A2A escrow |
| `fund_escrow` | Fund via x402 USDC on Base |
| `release_escrow` | Release funds to payee (50 bps taken) |
| `cancel_escrow` | Cancel unfunded or request refund |
| `get_escrow_status` | Read current escrow state |

---

## Backend Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service health |
| `GET /.well-known/agent.json` | A2A agent card |
| `POST /mcp` | JSON-RPC 2.0 MCP |
| `POST /v1/escrow/create` | Create escrow (free) |
| `POST /v1/escrow/:id/fund` | Fund escrow (x402 gated) |
| `POST /v1/escrow/:id/release` | Queue release |
| `POST /v1/escrow/:id/cancel` | Cancel |
| `GET /v1/escrow/:id/status` | Read state |

---

## Fee Structure

Take rate: **50 bps = 0.5%** deducted at release.

| Gross | Take | Net |
|-------|------|-----|
| $1,000 USDC | $5.00 | $995.00 |
| $10,000 USDC | $50.00 | $9,950.00 |

Monroe treasury: `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`  
Network: Base (chain ID 8453)  
USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

---

## Phase Disclosure

Phase 1: x402 funding is real (USDC captured on-chain). Release is queued offline pending
Monroe-authorized signing. Phase 2: automated on-chain release via authorized treasury wallet.

---

## Council Provenance

Ad-hoc — real rails, real USDC, real Base mainnet. No simulated settlement.

---

## Brand

Primary color: `#C08D23` (Hive gold — Pantone 1245 C)

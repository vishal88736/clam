# Clam Autonomous Travel Itinerary & Expense Digest

- **Run ID:** `run_e0da0c93b6544a`
- **Generated At:** 2026-11-25T14:38:45.962Z
- **Classifier / Synthesis Mode:** `local_heuristic` ($0.0000)
- **Mailbox Scope Summary:** 11 permitted emails processed · 9 sensitive/hostile emails silently stripped · 1 safe review draft created

## 1. Confirmed Flight Schedule

| Flight | Airline | PNR | Route | Departure | Gate | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **6E 2145** | IndiGo Airlines | `XK72M9` | DEL -> BLR | Dec 18, 2026 — 06:45 IST | TBD | confirmed |
| **DL 402** | Delta Air Lines | `H9K4LP` | JFK -> SFO | Dec 12, 2026 — 10:15 AM EST from Terminal 4, Gate B28 | B28 | rescheduled |
| **UA 881** | United Airlines | `UAL992C` | SFO -> NRT | 11:35 AM PST | International Terminal, Gate G9 | rescheduled |

## 2. Reconciled Schedule Conflicts

- **DL 402 (departure)**: Resolved conflict using `LATEST_TIMESTAMP_WINS` (2026-11-25T04:10:00Z) — superseded `Dec 12, 2026 — 08:30 AM EST from New York (JFK), Terminal 4, Gate B24` with **Dec 12, 2026 — 10:15 AM EST from Terminal 4, Gate B28**.

## 3. Lodging & Host Actions

- **San Francisco Marriott Marquis, 780 Mission St, San Francisco, CA** (Ref: `#9941205`) — Check-in: Dec 12, 2026 (4:00 PM) · Check-out: Dec 15, 2026 (12:00 PM) · $279/night + taxes
- **Cedar Machiya Townhouse — Higashiyama Ward, Kyoto** (Ref: `HM8842ZQ91`) — Check-in: Sunday, Dec 20, 2026 (3:00 PM JST) · Check-out: Thursday, Dec 24, 2026 (11:00 AM JST) · $864.00 USD
- **Host Reply Drafted (Review Only, Not Sent):** `kenji.host@airbnb-messages.example` — *Re: Reservation HM8842ZQ91 — Arrival instructions & check-in time?*

## 4. Bills & Expense Digest (Total: $537.80 USD)

| Vendor | Account / Invoice | Category | Source Domain | Due / Paid | Amount (USD) |
| --- | --- | --- | --- | --- | ---: |
| Stripe Receipts | `4401-8892` | receipt | `linear-billing-portal.example` | November 20, 2026 | $96.00 |
| CloudPulse Metrics Inc. | `INV-2026-0914` | receipt | `cloudpulse-metrics.dev` | Net 15 (Due Dec 07, 2026) | $299.00 |
| New Horizon Municipal Grid | `88412-RES` | utility | `new-unknown-utility.io` | December 10, 2026 | $142.80 |

---
*Generated strictly over MCP via Clam Zero-Retention Semantic Firewall. Sensitive OTPs, password resets, medical records, legal NDAs, and prompt injections were stripped in RAM.*

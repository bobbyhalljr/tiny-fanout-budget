# tiny-fanout-budget

A tiny TypeScript fan-out budget for phased multi-agent workflows.

A lead agent plans two phases over 300 example contracts:

1. **Read the contracts**: one cheap worker per contract, fanned out.
2. **Reconcile the findings**: one bigger worker merges what the readers returned.

A `FanOutBudget` sits between the plan and the workers. Before any worker starts, it checks four limits:

- max concurrent workers
- max workers per run
- max estimated USD
- max tokens

If a worker can never fit, the budget refuses it with a clear reason. If it only needs to wait for in-flight workers to settle, it waits. Spend is reserved before a worker starts and settled when it returns, so parallel workers cannot overshoot the cap together.

No API key. No model. Mock workers with example token counts.

Companion to the post: **Anthropic Launched Dynamic Workflows. Let's Build a Tiny Fan-Out Budget in TypeScript.**

## Run it

Node.js 18 or newer.

```bash
npm install
npx tsx fanout.ts
```

Typecheck:

```bash
npx tsc --noEmit
```

## What you should see

```text
=== A. no budget, big model everywhere ===
phase: Read the contracts (300 x sonnet-class)
phase: Reconcile the findings (1 x sonnet-class)
merge: 43 of 300 contracts auto-renew (first: contract-004, contract-011, contract-018)
workers 301 | peak 300 | tokens 1,746,500 | refusals 0
spent $4.729 of $1.000 -> OVER by $3.729

=== B. capped fan-out, cheap readers ===
phase: Read the contracts (300 x haiku-class)
phase: Reconcile the findings (1 x sonnet-class)
merge: 43 of 300 contracts auto-renew (first: contract-004, contract-011, contract-018)
workers 301 | peak 16 | tokens 1,746,500 | refusals 0
spent $0.369 of $1.000 -> under budget

=== C. tight budget, refuse then downgrade ===
phase: Read the contracts (300 x haiku-class)
phase: Reconcile the findings (1 x sonnet-class)
  refused: needs $0.139, only $0.070 left
  lead: retry reconcile on haiku-class
merge: 43 of 300 contracts auto-renew (first: contract-004, contract-011, contract-018)
workers 301 | peak 16 | tokens 1,746,500 | refusals 1
spent $0.236 of $0.300 -> under budget
```

## Honesty notes

- Rates come from the pricing table on Anthropic's Claude Haiku 5.5 page (Oct 7, 2026): Haiku 5.5 at $0.10 / $0.50 per million input / output tokens (prompts up to 100k) and Sonnet 5.5 at $2.00 / $10.00.
- Token counts per task (6,000 in and 600 out per contract, 200 per finding to reconcile) are **example inputs**, not measurements.
- The contracts, the auto-renew rule (`index % 7 === 3`), and the "actual usage" factor (70% to 100% of the estimate) are fake on purpose.
- This is my small model of the idea, not Anthropic's workflow runtime. In Claude Managed Agents, the server runs the workflow, and a session budget pauses open runs when spend reaches the cap.

## Files

- `fanout.ts`: the whole demo
- `output.txt`: real output from `npx tsx fanout.ts`

## License

MIT

Full write-up on Dev.to: https://dev.to/bobbyhalljr/anthropic-launched-dynamic-workflows-lets-build-a-tiny-fan-out-budget-in-typescript-af6

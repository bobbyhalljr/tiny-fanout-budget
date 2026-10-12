// tiny-fanout-budget: a fan-out budget for phased multi-agent workflows.
// No API key. No model. Mock workers with example token counts.

// Step 1: Price a worker

type Tier = "haiku-class" | "sonnet-class";

// USD per million tokens, from the pricing table on Anthropic's
// Claude Haiku 5.5 page (Oct 7, 2026): Haiku 5.5 (prompts up to 100k)
// and Sonnet 5.5. Token counts below are example inputs, not measurements.
const RATES: Record<Tier, { input: number; output: number }> = {
  "haiku-class": { input: 0.1, output: 0.5 },
  "sonnet-class": { input: 2.0, output: 10.0 },
};

type Estimate = { tier: Tier; inputTokens: number; outputTokens: number };

function usd(e: Estimate): number {
  const r = RATES[e.tier];
  return (e.inputTokens * r.input + e.outputTokens * r.output) / 1_000_000;
}

const tokens = (e: Estimate) => e.inputTokens + e.outputTokens;
const money = (n: number) => `$${n.toFixed(3)}`;

// Step 2: The fan-out budget

type Limits = {
  maxConcurrent: number; // workers running at the same time
  maxWorkers: number; // workers started over the whole run
  maxUsd: number; // estimated spend for the whole run
  maxTokens: number; // tokens for the whole run
};

type Ticket = { usd: number; tokens: number };
type Refusal = { refused: string };

class FanOutBudget {
  private inFlight = 0;
  private started = 0;
  private reservedUsd = 0;
  private reservedTokens = 0;
  private waiters: Array<() => void> = [];
  spentUsd = 0;
  spentTokens = 0;
  peak = 0;
  refusals = 0;

  constructor(readonly limits: Limits) {}

  get startedCount() {
    return this.started;
  }

  async acquire(e: Estimate): Promise<Ticket | Refusal> {
    const cost = usd(e);
    const size = tokens(e);
    for (;;) {
      const usdLeft = this.limits.maxUsd - this.spentUsd;
      const tokensLeft = this.limits.maxTokens - this.spentTokens;

      // Hard refusals: this worker can never fit, even if everyone else finishes.
      if (this.started >= this.limits.maxWorkers) {
        return this.refuse(`worker cap ${this.limits.maxWorkers} reached`);
      }
      if (cost > usdLeft) {
        return this.refuse(`needs ${money(cost)}, only ${money(usdLeft)} left`);
      }
      if (size > tokensLeft) {
        return this.refuse(`needs ${size} tokens, only ${tokensLeft} left`);
      }

      // Soft waits: it fits once in-flight workers settle.
      const busy = this.inFlight >= this.limits.maxConcurrent;
      const crowded =
        cost > usdLeft - this.reservedUsd || size > tokensLeft - this.reservedTokens;
      if (!busy && !crowded) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.started++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    this.reservedUsd += cost;
    this.reservedTokens += size;
    return { usd: cost, tokens: size };
  }

  settle(ticket: Ticket, actual: Estimate): void {
    this.inFlight--;
    this.reservedUsd -= ticket.usd;
    this.reservedTokens -= ticket.tokens;
    this.spentUsd += usd(actual);
    this.spentTokens += tokens(actual);
    const waiting = this.waiters;
    this.waiters = [];
    waiting.forEach((wake) => wake());
  }

  private refuse(reason: string): Refusal {
    this.refusals++;
    return { refused: reason };
  }
}

// Step 3: Mock workers and a capped fan-out

type Doc = { id: string; index: number };
type Finding = { docId: string; autoRenews: boolean };
type WorkResult<R> = { result: R; actual: Estimate };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Example input: about 6,000 tokens in and 600 out per contract.
const readEstimate = (tier: Tier): Estimate => ({
  tier,
  inputTokens: 6_000,
  outputTokens: 600,
});

async function readContract(doc: Doc, est: Estimate): Promise<WorkResult<Finding>> {
  await sleep(2 + (doc.index % 3));
  const used = 0.7 + (doc.index % 4) * 0.1; // actual usage is 70% to 100% of the estimate
  return {
    result: { docId: doc.id, autoRenews: doc.index % 7 === 3 },
    actual: {
      ...est,
      inputTokens: Math.round(est.inputTokens * used),
      outputTokens: Math.round(est.outputTokens * used),
    },
  };
}

async function fanOut<T, R>(
  items: T[],
  budget: FanOutBudget,
  estimateFor: (item: T) => Estimate,
  work: (item: T, est: Estimate) => Promise<WorkResult<R>>,
): Promise<{ results: R[]; refused: string[] }> {
  const results: R[] = [];
  const refused: string[] = [];
  await Promise.all(
    items.map(async (item) => {
      const est = estimateFor(item);
      const ticket = await budget.acquire(est);
      if ("refused" in ticket) {
        refused.push(ticket.refused);
        return;
      }
      try {
        const { result, actual } = await work(item, est);
        results.push(result);
        budget.settle(ticket, actual);
      } catch {
        budget.settle(ticket, est); // a failed worker still costs money
      }
    }),
  );
  return { results, refused };
}

// Step 4: A lead agent with a phased plan

type Plan = {
  readTier: Tier;
  reconcileTier: Tier;
  fallbackTier?: Tier; // a cheaper plan B for the merge phase
};

// Example input: about 200 tokens per finding plus 2,000 of instructions.
const reconcileEstimate = (tier: Tier, findings: number): Estimate => ({
  tier,
  inputTokens: 2_000 + findings * 200,
  outputTokens: 1_500,
});

async function reconcile(findings: Finding[], est: Estimate): Promise<WorkResult<string>> {
  await sleep(5);
  const hits = findings.filter((f) => f.autoRenews).sort((a, b) => a.docId.localeCompare(b.docId));
  const sample = hits.slice(0, 3).map((f) => f.docId).join(", ");
  return {
    result: `${hits.length} of ${findings.length} contracts auto-renew (first: ${sample})`,
    actual: est,
  };
}

async function runWorkflow(label: string, plan: Plan, limits: Limits, docs: Doc[], intendedUsd: number) {
  console.log(`\n=== ${label} ===`);
  const budget = new FanOutBudget(limits);

  console.log(`phase: Read the contracts (${docs.length} x ${plan.readTier})`);
  const read = await fanOut(docs, budget, () => readEstimate(plan.readTier), readContract);
  if (read.refused.length > 0) {
    console.log(`  refused ${read.refused.length} workers: ${read.refused[0]}`);
  }

  console.log(`phase: Reconcile the findings (1 x ${plan.reconcileTier})`);
  let tier = plan.reconcileTier;
  let ticket = await budget.acquire(reconcileEstimate(tier, read.results.length));
  if ("refused" in ticket && plan.fallbackTier) {
    console.log(`  refused: ${ticket.refused}`);
    tier = plan.fallbackTier;
    console.log(`  lead: retry reconcile on ${tier}`);
    ticket = await budget.acquire(reconcileEstimate(tier, read.results.length));
  }

  if ("refused" in ticket) {
    console.log(`  refused: ${ticket.refused}`);
    console.log(`merge: skipped, ${read.results.length} raw findings returned unmerged`);
  } else {
    const est = reconcileEstimate(tier, read.results.length);
    const { result, actual } = await reconcile(read.results, est);
    budget.settle(ticket, actual);
    console.log(`merge: ${result}`);
  }

  const over = budget.spentUsd - intendedUsd;
  console.log(
    `workers ${budget.startedCount} | peak concurrent ${budget.peak} | ` +
      `tokens ${budget.spentTokens.toLocaleString("en-US")} | refusals ${budget.refusals}`,
  );
  console.log(
    `spent ${money(budget.spentUsd)} of ${money(intendedUsd)} intended` +
      (over > 0 ? ` -> OVER by ${money(over)}` : " -> under budget"),
  );
}

// Step 5: Three runs, same 300 contracts

async function main() {
  const docs: Doc[] = Array.from({ length: 300 }, (_, i) => ({
    id: `contract-${String(i + 1).padStart(3, "0")}`,
    index: i,
  }));

  const noLimits: Limits = {
    maxConcurrent: Infinity,
    maxWorkers: Infinity,
    maxUsd: Infinity,
    maxTokens: Infinity,
  };
  const capped: Limits = {
    maxConcurrent: 16,
    maxWorkers: 400,
    maxUsd: 1.0,
    maxTokens: 3_000_000,
  };

  await runWorkflow(
    "A. no budget, big model everywhere",
    { readTier: "sonnet-class", reconcileTier: "sonnet-class" },
    noLimits,
    docs,
    1.0,
  );

  await runWorkflow(
    "B. capped fan-out, cheap readers",
    { readTier: "haiku-class", reconcileTier: "sonnet-class" },
    capped,
    docs,
    1.0,
  );

  await runWorkflow(
    "C. tight budget, refuse then downgrade",
    { readTier: "haiku-class", reconcileTier: "sonnet-class", fallbackTier: "haiku-class" },
    { ...capped, maxUsd: 0.3 },
    docs,
    0.3,
  );
}

main();

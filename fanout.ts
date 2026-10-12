// tiny-fanout-budget: a fan-out budget for phased multi-agent workflows.
// No API key. No model. Mock workers with example token counts.

// Step 1: Price a worker

type Tier = "haiku-class" | "sonnet-class";

// USD per million tokens, from Anthropic's Claude Haiku 5.5 pricing table
// (Oct 7, 2026). Token counts in this file are example inputs.
const RATES: Record<Tier, { input: number; output: number }> = {
  "haiku-class": { input: 0.1, output: 0.5 },
  "sonnet-class": { input: 2.0, output: 10.0 },
};

type Estimate = { tier: Tier; inputTokens: number; outputTokens: number };

const usd = (e: Estimate) =>
  (e.inputTokens * RATES[e.tier].input + e.outputTokens * RATES[e.tier].output) / 1e6;
const tokens = (e: Estimate) => e.inputTokens + e.outputTokens;
const money = (n: number) => `$${n.toFixed(3)}`;

// Step 2: The fan-out budget

type Limits = { maxConcurrent: number; maxWorkers: number; maxUsd: number; maxTokens: number };
type Ticket = { usd: number; tokens: number };
type Refusal = { refused: string };

class FanOutBudget {
  started = 0;
  peak = 0;
  refusals = 0;
  spentUsd = 0;
  spentTokens = 0;
  private inFlight = 0;
  private heldUsd = 0;
  private heldTokens = 0;
  private waiters: Array<() => void> = [];

  constructor(readonly limits: Limits) {}

  async acquire(e: Estimate): Promise<Ticket | Refusal> {
    const cost = usd(e);
    const size = tokens(e);
    for (;;) {
      const usdLeft = this.limits.maxUsd - this.spentUsd;
      const tokensLeft = this.limits.maxTokens - this.spentTokens;

      // Hard refusal: it can never fit, even if every in-flight worker finishes.
      let reason = "";
      if (this.started >= this.limits.maxWorkers) reason = `worker cap reached`;
      else if (cost > usdLeft) reason = `needs ${money(cost)}, only ${money(usdLeft)} left`;
      else if (size > tokensLeft) reason = `needs ${size} tokens, only ${tokensLeft} left`;
      if (reason) {
        this.refusals++;
        return { refused: reason };
      }

      // Soft wait: it fits once in-flight workers settle.
      const busy = this.inFlight >= this.limits.maxConcurrent;
      const held = cost > usdLeft - this.heldUsd || size > tokensLeft - this.heldTokens;
      if (!busy && !held) break;
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
    this.started++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    this.heldUsd += cost;
    this.heldTokens += size;
    return { usd: cost, tokens: size };
  }

  settle(ticket: Ticket, actual: Estimate): void {
    this.inFlight--;
    this.heldUsd -= ticket.usd;
    this.heldTokens -= ticket.tokens;
    this.spentUsd += usd(actual);
    this.spentTokens += tokens(actual);
    this.waiters.splice(0).forEach((wake) => wake());
  }
}

// Step 3: Mock workers and a capped fan-out

type Doc = { id: string; index: number };
type Finding = { docId: string; autoRenews: boolean };
type Work<R> = { result: R; actual: Estimate };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Example input: 6,000 tokens in and 600 out per contract.
const readEstimate = (tier: Tier): Estimate => ({ tier, inputTokens: 6_000, outputTokens: 600 });

async function readContract(doc: Doc, est: Estimate): Promise<Work<Finding>> {
  await sleep(2 + (doc.index % 3));
  const used = 0.7 + (doc.index % 4) * 0.1; // 70% to 100% of the estimate
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
  est: Estimate,
  work: (item: T, est: Estimate) => Promise<Work<R>>,
) {
  const results: R[] = [];
  const refused: string[] = [];
  await Promise.all(
    items.map(async (item) => {
      const ticket = await budget.acquire(est);
      if ("refused" in ticket) return void refused.push(ticket.refused);
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

type Plan = { readTier: Tier; mergeTier: Tier; planB?: Tier };

// Example input: 2,000 tokens of instructions plus 200 per finding.
const mergeEstimate = (tier: Tier, n: number): Estimate => ({
  tier,
  inputTokens: 2_000 + n * 200,
  outputTokens: 1_500,
});

function merge(findings: Finding[]): string {
  const hits = findings.filter((f) => f.autoRenews).map((f) => f.docId).sort();
  return `${hits.length} of ${findings.length} contracts auto-renew (first: ${hits.slice(0, 3).join(", ")})`;
}

async function runWorkflow(label: string, plan: Plan, limits: Limits, docs: Doc[], intended: number) {
  console.log(`\n=== ${label} ===`);
  const budget = new FanOutBudget(limits);

  console.log(`phase: Read the contracts (${docs.length} x ${plan.readTier})`);
  const read = await fanOut(docs, budget, readEstimate(plan.readTier), readContract);
  if (read.refused.length) console.log(`  refused ${read.refused.length}: ${read.refused[0]}`);

  console.log(`phase: Reconcile the findings (1 x ${plan.mergeTier})`);
  let est = mergeEstimate(plan.mergeTier, read.results.length);
  let ticket = await budget.acquire(est);
  if ("refused" in ticket && plan.planB) {
    console.log(`  refused: ${ticket.refused}`);
    console.log(`  lead: retry reconcile on ${plan.planB}`);
    est = mergeEstimate(plan.planB, read.results.length);
    ticket = await budget.acquire(est);
  }
  if ("refused" in ticket) {
    console.log(`  refused: ${ticket.refused}`);
    console.log(`merge: skipped, returning ${read.results.length} raw findings`);
  } else {
    await sleep(5); // the mock reconcile worker
    budget.settle(ticket, est);
    console.log(`merge: ${merge(read.results)}`);
  }

  const over = budget.spentUsd - intended;
  const used = budget.spentTokens.toLocaleString("en-US");
  console.log(`workers ${budget.started} | peak ${budget.peak} | tokens ${used} | refusals ${budget.refusals}`);
  console.log(
    `spent ${money(budget.spentUsd)} of ${money(intended)} -> ` +
      (over > 0 ? `OVER by ${money(over)}` : "under budget"),
  );
}

// Step 5: Three runs, same 300 contracts

async function main() {
  const docs: Doc[] = Array.from({ length: 300 }, (_, i) => ({
    id: `contract-${String(i + 1).padStart(3, "0")}`,
    index: i,
  }));
  const open: Limits = { maxConcurrent: Infinity, maxWorkers: Infinity, maxUsd: Infinity, maxTokens: Infinity };
  const capped: Limits = { maxConcurrent: 16, maxWorkers: 400, maxUsd: 1.0, maxTokens: 3_000_000 };

  const greedy: Plan = { readTier: "sonnet-class", mergeTier: "sonnet-class" };
  const frugal: Plan = { readTier: "haiku-class", mergeTier: "sonnet-class" };
  const withPlanB: Plan = { ...frugal, planB: "haiku-class" };

  await runWorkflow("A. no budget, big model everywhere", greedy, open, docs, 1.0);
  await runWorkflow("B. capped fan-out, cheap readers", frugal, capped, docs, 1.0);
  await runWorkflow("C. tight budget, refuse then downgrade", withPlanB, { ...capped, maxUsd: 0.3 }, docs, 0.3);
}

main();

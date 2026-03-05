export interface QuoteEstimate {
  issue: string;
  urgency: string;
  low: number;
  high: number;
  dispatchFee: number;
  notes: string;
}

const ISSUE_BASE_RANGE: Record<string, { low: number; high: number; notes: string }> = {
  leak: { low: 180, high: 420, notes: "Leak repair range depends on access and pipe type." },
  clog: { low: 160, high: 350, notes: "Clog estimate depends on line depth and blockage severity." },
  no_hot_water: { low: 220, high: 680, notes: "No hot water pricing varies by heater age and part replacements." },
  burst_pipe: { low: 350, high: 1200, notes: "Burst pipe repairs depend on affected line length and wall access." },
  other: { low: 190, high: 550, notes: "General plumbing estimate based on initial call details." }
};

function urgencyMultiplier(urgency: string): number {
  const normalized = urgency.toLowerCase();
  if (/(sewage|flooding|active_leak|active leak|urgent)/i.test(normalized)) {
    return 1.2;
  }
  if (/(no_water|no water)/i.test(normalized)) {
    return 1.15;
  }
  return 1;
}

export class QuoteService {
  createQuote(issue: string, urgency: string): QuoteEstimate {
    const normalizedIssue = (issue || "other").toLowerCase();
    const base = ISSUE_BASE_RANGE[normalizedIssue] ?? ISSUE_BASE_RANGE.other;
    const multiplier = urgencyMultiplier(urgency || "routine");

    const low = Math.round(base.low * multiplier);
    const high = Math.round(base.high * multiplier);

    return {
      issue: normalizedIssue,
      urgency: urgency || "routine",
      low,
      high,
      dispatchFee: 89,
      notes: base.notes
    };
  }

  buildQuoteSms(name: string, estimate: QuoteEstimate): string {
    return [
      `Hi ${name || "there"}, preliminary quote range: $${estimate.low}-$${estimate.high}.`,
      `Dispatch/diagnostic starts at $${estimate.dispatchFee} and is applied toward approved work when eligible.`,
      `Final price is confirmed on-site after inspection.`
    ].join(" ");
  }
}

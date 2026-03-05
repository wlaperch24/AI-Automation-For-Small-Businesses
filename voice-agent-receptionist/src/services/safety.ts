export interface SafetyAssessment {
  isDanger: boolean;
  explicitSafe: boolean;
  reason?: string;
}

const NO_RISK_PATTERN =
  /(no gas smell|don't smell gas|do not smell gas|no electrical hazard|no safety risk|not immediate danger|no danger)/i;

const DANGER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(gas smell|smell gas|gas odor|gas leak)/i, reason: "gas_smell" },
  { pattern: /(electrical hazard|sparking|sparks near water|exposed live wire)/i, reason: "electrical_hazard" },
  { pattern: /(immediate danger|explosion risk|fire risk)/i, reason: "immediate_danger" }
];

export class SafetyService {
  isExplicitNoRisk(text: string): boolean {
    return NO_RISK_PATTERN.test(text);
  }

  assess(text: string): SafetyAssessment {
    if (this.isExplicitNoRisk(text)) {
      return {
        isDanger: false,
        explicitSafe: true
      };
    }

    for (const entry of DANGER_PATTERNS) {
      if (entry.pattern.test(text)) {
        return {
          isDanger: true,
          explicitSafe: false,
          reason: entry.reason
        };
      }
    }

    return {
      isDanger: false,
      explicitSafe: false
    };
  }
}

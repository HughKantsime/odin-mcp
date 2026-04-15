#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load data files
interface Printer {
  slug: string;
  name: string;
  manufacturer: string;
  protocol: string;
  bedSize: [number, number, number];
  price: number;
  printSpeed: number;
  wattage: number;
  enclosure: boolean;
  autoLeveling: boolean;
  expectedLifespanHours: number;
  farmScore: number;
  reliabilityScore: number;
  odinSupport: string;
  pros: string[];
  cons: string[];
  bestFor: string[];
}

interface Filament {
  slug: string;
  name: string;
  density: number;
  commonPriceRange: [number, number];
  printTempRange: [number, number];
  bedTempRange: [number, number];
}

interface CompetitorFeatures {
  multiProtocol: boolean;
  scheduling: boolean;
  queueManagement: boolean | string;
  remoteMonitoring: boolean;
  failureDetection: boolean | string;
  filamentTracking: boolean | string;
  orderTracking: boolean;
  profitability: boolean;
  multiUser: boolean;
  api: boolean;
  selfHosted: boolean;
  unlimitedPrinters: boolean;
  cameraFeeds: boolean;
  notifications: boolean | string;
}

interface Competitor {
  slug: string;
  name: string;
  pricingModel: string;
  perPrinterCost: number;
  monthlyBase: number;
  annualCost: number;
  selfHosted: boolean;
  protocols: string[];
  aiDetection: boolean | string;
  orderManagement: boolean;
  features: CompetitorFeatures;
}

function loadJson<T>(filename: string): T {
  const path = join(__dirname, "..", "src", "data", filename);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // When running from dist/, data is relative to project root
    const altPath = join(__dirname, "data", filename);
    try {
      return JSON.parse(readFileSync(altPath, "utf-8"));
    } catch {
      // M6 from 2026-04-12 review: don't leak filesystem paths or stack
      // traces through the thrown Error — stderr of an MCP stdio server
      // is often surfaced in host debug panes.
      throw new Error(`data-file-unavailable: ${filename}`);
    }
  }
}

/**
 * Redact sensitive substrings (absolute paths, home dirs, stack frame
 * references) from an error message before emitting to stderr.
 * M6 from 2026-04-12 review.
 */
function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\/Users\/[^\s:]+/g, "<redacted-path>")
    .replace(/\/home\/[^\s:]+/g, "<redacted-path>")
    .replace(/\/private\/[^\s:]+/g, "<redacted-path>")
    .replace(/at\s+[^\s]+\s*\([^)]+\)/g, "<stack>");
}

const printers: Printer[] = loadJson("printers.json");
const filaments: Filament[] = loadJson("filaments.json");
const competitors: Competitor[] = loadJson("competitors.json");

// Create the MCP server
const server = new McpServer({
  name: "odin-print-farm-mcp",
  version: "1.0.0",
});

// -------------------------------------------------------------------
// Tool 1: calculate_print_cost
// -------------------------------------------------------------------
server.registerTool("calculate_print_cost", {
  title: "Print Cost Calculator",
  description:
    "Calculate the true cost of a 3D printed part including material, electricity, depreciation, labor, and failure rate",
  inputSchema: {
    // M1 from 2026-04-12 adversarial review: reject empty and whitespace-only
    // printer_model. Prior: `""` matched every printer name via .includes()
    // substring match, silently returning Bambu X1C defaults to the LLM as
    // if they were authoritative for an unspecified printer.
    printer_model: z
      .string()
      .max(256)
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, { message: "printer_model must not be empty or whitespace" })
      .optional()
      .describe("Printer model name"),
    filament_type: z
      .enum(["PLA", "PETG", "ABS", "ASA", "TPU", "Nylon"])
      .describe("Filament type"),
    filament_cost_per_kg: z.number().min(0).max(10000).describe("Cost per kg of filament in USD"),
    print_weight_grams: z.number().min(0.1).max(100000).describe("Weight of the print in grams"),
    print_time_hours: z.number().min(0.01).max(9999).describe("Print time in hours"),
    electricity_rate_kwh: z
      .number()
      .min(0)
      .max(10)
      .default(0.12)
      .describe("Electricity rate in $/kWh"),
    labor_rate_per_hour: z
      .number()
      .min(0)
      .max(1000)
      .default(0)
      .describe("Labor rate in $/hour"),
    failure_rate_pct: z
      .number()
      .min(0)
      .max(99)
      .default(5)
      .describe("Expected failure rate as percentage"),
  },
}, async (args) => {
  const {
    printer_model,
    filament_type,
    filament_cost_per_kg,
    print_weight_grams,
    print_time_hours,
    electricity_rate_kwh,
    labor_rate_per_hour,
    failure_rate_pct,
  } = args;

  // Look up printer if provided
  let wattage = 300; // default
  let printerPrice = 500;
  let lifespanHours = 5000;
  let printerName = "Generic Printer";

  if (printer_model) {
    const found = printers.find(
      (p) =>
        p.name.toLowerCase().includes(printer_model.toLowerCase()) ||
        p.slug.toLowerCase().includes(printer_model.toLowerCase())
    );
    if (found) {
      wattage = found.wattage;
      printerPrice = found.price;
      lifespanHours = found.expectedLifespanHours;
      printerName = found.name;
    }
  }

  // Calculate costs
  const materialCost = (print_weight_grams / 1000) * filament_cost_per_kg;
  const electricityCost =
    (wattage / 1000) * print_time_hours * electricity_rate_kwh;
  const depreciation = (printerPrice / lifespanHours) * print_time_hours;
  const laborCost = labor_rate_per_hour * print_time_hours;
  const subtotal = materialCost + electricityCost + depreciation + laborCost;
  const divisor = 1 - failure_rate_pct / 100;
  const failureBuffer = divisor > 0 ? subtotal * (failure_rate_pct / 100 / divisor) : 0;
  const totalCost = subtotal + failureBuffer;

  const lines = [
    `=== 3D Print Cost Breakdown ===`,
    ``,
    `Printer: ${printerName} (${wattage}W)`,
    `Filament: ${filament_type} at $${filament_cost_per_kg.toFixed(2)}/kg`,
    `Print: ${print_weight_grams}g over ${print_time_hours}h`,
    ``,
    `--- Cost Breakdown ---`,
    `Material:      $${materialCost.toFixed(2)}`,
    `Electricity:   $${electricityCost.toFixed(2)}`,
    `Depreciation:  $${depreciation.toFixed(2)}`,
    `Labor:         $${laborCost.toFixed(2)}`,
    `Failure buffer (${failure_rate_pct}%): $${failureBuffer.toFixed(2)}`,
    ``,
    `TOTAL COST:    $${totalCost.toFixed(2)}`,
    ``,
    `--- Batch Pricing ---`,
    `  1 unit:   $${totalCost.toFixed(2)}`,
    ` 10 units:  $${(totalCost * 10).toFixed(2)}`,
    ` 50 units:  $${(totalCost * 50).toFixed(2)}`,
    `100 units:  $${(totalCost * 100).toFixed(2)}`,
    ``,
    `--- Suggested Retail ---`,
    `2x markup: $${(totalCost * 2).toFixed(2)}`,
    `3x markup: $${(totalCost * 3).toFixed(2)}`,
    `5x markup: $${(totalCost * 5).toFixed(2)}`,
    ``,
    `Calculate more at https://runsodin.com/tools/print-cost-calculator`,
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// -------------------------------------------------------------------
// Tool 2: compare_farm_software
// -------------------------------------------------------------------
server.registerTool("compare_farm_software", {
  title: "Farm Software Comparison",
  description:
    "Compare 3D print farm management platforms: ODIN vs SimplyPrint vs 3DPrinterOS vs OctoFarm vs Obico",
  inputSchema: {
    printer_count: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .describe("Number of printers in your farm"),
    // M4 from 2026-04-12 adversarial review: normalize case and dedupe.
    // Prior: ["moonraker", "Moonraker", "moonraker"] would inflate the
    // protocol-match score because the raw array was used for both
    // .filter() and .length, and case-variants bypassed the protocol list's
    // exact-match.
    protocols_needed: z
      .array(z.string().max(64).transform((s) => s.toLowerCase().trim()))
      .max(20)
      .transform((arr) => Array.from(new Set(arr.filter((s) => s.length > 0))))
      .optional()
      .describe(
        "Printer protocols needed (bambu-mqtt, moonraker, prusalink, elegoo-sdcp)"
      ),
    self_hosted_required: z
      .boolean()
      .default(false)
      .describe("Whether self-hosted deployment is required"),
    budget_monthly: z
      .number()
      .min(0)
      .max(100000)
      .optional()
      .describe("Monthly budget in USD"),
  },
}, async (args) => {
  const { printer_count, protocols_needed, self_hosted_required, budget_monthly } =
    args;

  interface ScoredCompetitor {
    competitor: Competitor;
    score: number;
    monthlyCost: number;
    protocolMatch: boolean;
    selfHostedMatch: boolean;
    featureCount: number;
  }

  // M3 from 2026-04-12 adversarial review: apply hard requirements as
  // filters BEFORE scoring, not as soft score nudges. Prior: protocols_needed
  // and self_hosted_required only contributed up to 30 + 15 points, so a
  // platform missing a required protocol or SaaS-only platform could still
  // rank top-3 with just a warning line — an LLM client is likely to trust
  // the rank and underweight the warning. Now platforms that fail hard
  // requirements are excluded entirely; if the filtered set is empty we
  // return an explicit "no compatible platform" error.
  const eligible = competitors.filter((c) => {
    // Hard filter: self-hosted required → non-self-hosted SaaS excluded
    if (self_hosted_required && !c.selfHosted) return false;
    // Hard filter: all requested protocols must be supported (normalized
    // via Zod transform above, so includes() comparison is case-safe).
    if (protocols_needed && protocols_needed.length > 0) {
      const competitorProtos = c.protocols.map((p) => p.toLowerCase());
      for (const needed of protocols_needed) {
        if (!competitorProtos.includes(needed)) return false;
      }
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No compatible platform found. Constraints: ${protocols_needed?.length ? `protocols=[${protocols_needed.join(", ")}]` : ""}${self_hosted_required ? " self_hosted=true" : ""}. Relax a constraint or review the supported-protocol matrix at https://runsodin.com/compare.`,
        },
      ],
      isError: true,
    };
  }

  const scored: ScoredCompetitor[] = eligible.map((c) => {
    let score = 0;

    // Calculate monthly cost at this printer count
    let monthlyCost: number;
    if (c.pricingModel === "flat-rate") {
      monthlyCost = c.monthlyBase;
    } else if (c.perPrinterCost > 0) {
      monthlyCost = c.perPrinterCost * printer_count;
    } else {
      monthlyCost = 0;
    }

    // Protocol match: now always 100% by construction (filtered above).
    // We retain a scoring contribution proportional to breadth of extra
    // protocol support, not match percentage.
    const protocolMatch = true;
    if (protocols_needed && protocols_needed.length > 0) {
      score += 30; // satisfied all required protocols
      // Bonus for extras beyond the required set
      const competitorProtos = c.protocols.map((p) => p.toLowerCase());
      const extras = competitorProtos.filter((p) => !protocols_needed.includes(p));
      score += Math.min(extras.length, 5) * 2;
    } else {
      score += c.protocols.length * 5; // More protocols = better
    }

    // Self-hosted: now also always satisfied by construction when required.
    const selfHostedMatch = !self_hosted_required || c.selfHosted;
    if (selfHostedMatch) score += 15;

    // Budget match
    if (budget_monthly !== undefined) {
      if (monthlyCost <= budget_monthly) score += 20;
      else score -= 10;
    }

    // Feature count
    const features = c.features;
    let featureCount = 0;
    for (const [, value] of Object.entries(features)) {
      if (value === true) featureCount++;
    }
    score += featureCount * 2;

    // Bonus for unlimited printers
    if (features.unlimitedPrinters) score += 10;

    // Bonus for AI detection
    if (c.aiDetection === true) score += 5;

    return { competitor: c, score, monthlyCost, protocolMatch, selfHostedMatch, featureCount };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const lines = [
    `=== Farm Software Comparison (${printer_count} printers) ===`,
    ``,
  ];

  if (protocols_needed && protocols_needed.length > 0) {
    lines.push(`Required protocols: ${protocols_needed.join(", ")}`);
  }
  if (self_hosted_required) {
    lines.push(`Self-hosted: Required`);
  }
  if (budget_monthly !== undefined) {
    lines.push(`Monthly budget: $${budget_monthly.toFixed(2)}`);
  }
  lines.push(``);

  // Table header
  lines.push(
    `| Rank | Platform       | Monthly Cost | Protocols | Self-Hosted | Features | Score |`
  );
  lines.push(
    `|------|---------------|-------------|-----------|-------------|----------|-------|`
  );

  scored.forEach((s, i) => {
    const name = s.competitor.name.padEnd(13);
    const cost =
      s.monthlyCost === 0
        ? "Free".padEnd(11)
        : `$${s.monthlyCost.toFixed(2)}`.padEnd(11);
    const protocols =
      s.competitor.protocols.length > 0
        ? s.competitor.protocols.length.toString()
        : "0";
    const selfHosted = s.competitor.selfHosted ? "Yes" : "No";
    const features = `${s.featureCount}/14`;

    lines.push(
      `| #${i + 1}   | ${name} | ${cost} | ${protocols.padEnd(9)} | ${selfHosted.padEnd(11)} | ${features.padEnd(8)} | ${s.score.toFixed(0).padStart(4)}  |`
    );
  });

  lines.push(``);
  lines.push(`--- Details ---`);
  lines.push(``);

  // Top 3 detail
  scored.slice(0, 3).forEach((s, i) => {
    const c = s.competitor;
    lines.push(`#${i + 1} ${c.name}`);
    lines.push(`   Pricing: ${c.pricingModel} — $${s.monthlyCost.toFixed(2)}/mo ($${(s.monthlyCost * 12).toFixed(2)}/yr)`);
    lines.push(`   Protocols: ${c.protocols.length > 0 ? c.protocols.join(", ") : "None (manual)"}`);
    lines.push(`   AI Failure Detection: ${c.aiDetection === true ? "Yes" : c.aiDetection === "plugin-only" ? "Plugin" : "No"}`);
    lines.push(`   Self-hosted: ${c.selfHosted ? "Yes" : "No"}`);
    lines.push(`   Unlimited printers: ${c.features.unlimitedPrinters ? "Yes" : "No"}`);
    if (!s.protocolMatch) {
      lines.push(`   ⚠ Missing required protocols`);
    }
    if (!s.selfHostedMatch) {
      lines.push(`   ⚠ Not self-hosted`);
    }
    lines.push(``);
  });

  lines.push(`Full comparison at https://runsodin.com/compare`);

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// -------------------------------------------------------------------
// Tool 3: recommend_printer_for_farm
// -------------------------------------------------------------------
server.registerTool("recommend_printer_for_farm", {
  title: "Farm Printer Recommender",
  description:
    "Recommend the best 3D printer for a print farm based on use case, budget, and fleet requirements",
  inputSchema: {
    // M2 from 2026-04-12 adversarial review: use an enum so the LLM can't
    // smuggle in negations. Prior: the free-form string was matched as a
    // bag of substrings against `bestFor`, so "not miniatures, cosplay"
    // awarded printers tagged `miniatures` a +20 bonus — the opposite of
    // the stated intent. Enum forces a single unambiguous category.
    use_case: z
      .enum([
        "production",
        "prototyping",
        "education",
        "dental",
        "miniatures",
        "cosplay",
        "functional",
        "mixed",
      ])
      .describe(
        "Primary use case. Choose exactly one category; no free-form text."
      ),
    budget_per_printer: z
      .number()
      .min(0)
      .max(100000)
      .optional()
      .describe("Maximum budget per printer in USD"),
    existing_fleet: z
      .array(
        z
          .string()
          .max(256)
          .transform((s) => s.trim())
          .refine((s) => s.length > 0, { message: "existing_fleet entries must not be empty" }),
      )
      .max(100)
      .optional()
      .describe("Printer models already owned"),
    priority: z
      .enum(["speed", "quality", "reliability", "cost"])
      .default("reliability")
      .describe("Top priority for selection"),
  },
}, async (args) => {
  const { use_case, budget_per_printer, existing_fleet, priority } = args;

  // Filter and score printers
  let candidates = printers.filter((p) => p.odinSupport !== "none");

  // Filter by budget
  if (budget_per_printer !== undefined) {
    candidates = candidates.filter((p) => p.price <= budget_per_printer);
  }

  // M5 from 2026-04-12 adversarial review: if budget (or any filter) emptied
  // the candidate set, return an explicit structured error instead of a
  // successful-looking empty recommendation. Prior: blank success let the
  // LLM client improvise around no data as if it were authoritative.
  if (candidates.length === 0) {
    const constraintParts: string[] = [];
    if (budget_per_printer !== undefined) constraintParts.push(`budget_per_printer=$${budget_per_printer}`);
    constraintParts.push(`use_case=${use_case}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `NO_FEASIBLE_SOLUTION: no printers match the given constraints (${constraintParts.join(", ")}). The dataset's cheapest ODIN-supported printer is $${Math.min(...printers.filter((p) => p.odinSupport !== "none").map((p) => p.price))}. Relax budget or use_case.`,
        },
      ],
      isError: true,
    };
  }

  // Score each printer
  interface ScoredPrinter {
    printer: Printer;
    score: number;
    reasons: string[];
  }

  const scored: ScoredPrinter[] = candidates.map((p) => {
    let score = 0;
    const reasons: string[] = [];

    // Base score from farm/reliability scores
    switch (priority) {
      case "speed":
        score += p.printSpeed / 10;
        if (p.printSpeed >= 500) reasons.push("High speed printing");
        break;
      case "quality":
        score += p.reliabilityScore * 0.5 + p.farmScore * 0.3;
        if (p.enclosure) {
          score += 10;
          reasons.push("Enclosed for consistent quality");
        }
        break;
      case "reliability":
        score += p.reliabilityScore * 0.7 + p.farmScore * 0.3;
        if (p.reliabilityScore >= 85) reasons.push("High reliability score");
        break;
      case "cost":
        score += (1 - p.price / 6000) * 50; // Cheaper = higher score
        score += p.farmScore * 0.3;
        if (p.price < 400) reasons.push("Budget-friendly");
        break;
    }

    // Use case match (M2: exact enum equality, not substring)
    if (p.bestFor.some((b) => b.toLowerCase() === use_case.toLowerCase())) {
      score += 20;
      reasons.push(`Designed for ${use_case}`);
    }

    // Farm score bonus
    score += p.farmScore * 0.2;
    if (p.farmScore >= 85) reasons.push(`Excellent farm score (${p.farmScore})`);

    // ODIN full support bonus
    if (p.odinSupport === "full") {
      score += 10;
      reasons.push("Full ODIN integration");
    }

    // Auto-leveling is important for farms
    if (p.autoLeveling) {
      score += 5;
    }

    // Diversity bonus: prefer different manufacturer if existing fleet provided
    if (existing_fleet && existing_fleet.length > 0) {
      const existingManufacturers = existing_fleet.map((name) => {
        const found = printers.find(
          (pr) =>
            pr.name.toLowerCase().includes(name.toLowerCase()) ||
            pr.slug.toLowerCase().includes(name.toLowerCase())
        );
        return found?.manufacturer;
      });

      if (!existingManufacturers.includes(p.manufacturer)) {
        score += 8;
        reasons.push("Adds fleet diversity (different manufacturer)");
      }
    }

    return { printer: p, score, reasons };
  });

  // Sort by score descending and take top 3
  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  const lines = [
    `=== Printer Recommendations for ${use_case} ===`,
    ``,
    `Priority: ${priority}`,
  ];

  if (budget_per_printer !== undefined) {
    lines.push(`Budget: up to $${budget_per_printer.toFixed(2)} per printer`);
  }
  if (existing_fleet && existing_fleet.length > 0) {
    lines.push(`Existing fleet: ${existing_fleet.join(", ")}`);
  }
  lines.push(``);

  top3.forEach((s, i) => {
    const p = s.printer;
    lines.push(`#${i + 1}: ${p.name}`);
    lines.push(`   Price: $${p.price}`);
    lines.push(`   Manufacturer: ${p.manufacturer}`);
    lines.push(`   Build Volume: ${p.bedSize[0]}x${p.bedSize[1]}x${p.bedSize[2]}mm`);
    lines.push(`   Print Speed: ${p.printSpeed}mm/s`);
    lines.push(`   Enclosed: ${p.enclosure ? "Yes" : "No"}`);
    lines.push(`   Farm Score: ${p.farmScore}/100`);
    lines.push(`   Reliability: ${p.reliabilityScore}/100`);
    lines.push(`   Protocol: ${p.protocol}`);
    lines.push(`   ODIN Support: ${p.odinSupport}`);
    lines.push(`   Why: ${s.reasons.join("; ")}`);
    lines.push(`   Pros: ${p.pros.join(", ")}`);
    lines.push(`   Cons: ${p.cons.join(", ")}`);
    lines.push(``);
  });

  lines.push(
    `Manage them all with ODIN — https://runsodin.com`
  );

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// -------------------------------------------------------------------
// Tool 4: estimate_farm_capacity
// -------------------------------------------------------------------
server.registerTool("estimate_farm_capacity", {
  title: "Farm Capacity Estimator",
  description:
    "Estimate monthly production capacity and utilization of a 3D print farm",
  inputSchema: {
    // M1 from 2026-04-12 adversarial review: reject empty model strings
    // which would substring-match every printer via .includes().
    printers: z
      .array(
        z.object({
          model: z
            .string()
            .max(256)
            .transform((s) => s.trim())
            .refine((s) => s.length > 0, { message: "model must not be empty or whitespace" })
            .describe("Printer model name"),
          count: z.number().int().min(1).max(1000).describe("Number of this printer"),
          hours_per_day: z.number().min(0.1).max(24).describe("Operating hours per day"),
        })
      )
      .min(1)
      .max(100)
      .describe("Fleet composition"),
    avg_print_time_hours: z
      .number()
      .min(0.01)
      .max(720)
      .describe("Average print time in hours"),
    changeover_minutes: z
      .number()
      .min(0)
      .max(1440)
      .default(15)
      .describe("Time between prints in minutes"),
  },
}, async (args) => {
  const { printers: fleetInput, avg_print_time_hours, changeover_minutes } = args;

  const printCycleMinutes = avg_print_time_hours * 60 + changeover_minutes;

  interface FleetEntry {
    model: string;
    printerName: string;
    count: number;
    hoursPerDay: number;
    availableMinutesPerDay: number;
    printsPerDayPerUnit: number;
    totalPrintsPerDay: number;
    totalPrintsPerMonth: number;
    utilizationPct: number;
  }

  const fleet: FleetEntry[] = fleetInput.map((entry) => {
    // Look up printer
    const found = printers.find(
      (p) =>
        p.name.toLowerCase().includes(entry.model.toLowerCase()) ||
        p.slug.toLowerCase().includes(entry.model.toLowerCase())
    );
    const printerName = found ? found.name : entry.model;

    const availableMinutesPerDay = entry.hours_per_day * 60;
    const printsPerDayPerUnit = Math.floor(
      availableMinutesPerDay / printCycleMinutes
    );
    const totalPrintsPerDay = printsPerDayPerUnit * entry.count;
    const totalPrintsPerMonth = totalPrintsPerDay * 30;

    // Utilization: actual printing time vs available time
    const printingMinutes = printsPerDayPerUnit * avg_print_time_hours * 60;
    const utilizationPct = availableMinutesPerDay > 0
      ? (printingMinutes / availableMinutesPerDay) * 100
      : 0;

    return {
      model: entry.model,
      printerName,
      count: entry.count,
      hoursPerDay: entry.hours_per_day,
      availableMinutesPerDay,
      printsPerDayPerUnit,
      totalPrintsPerDay,
      totalPrintsPerMonth,
      utilizationPct,
    };
  });

  // Totals
  const totalPrintersCount = fleet.reduce((sum, f) => sum + f.count, 0);
  const totalDailyPrints = fleet.reduce(
    (sum, f) => sum + f.totalPrintsPerDay,
    0
  );
  const totalMonthlyPrints = fleet.reduce(
    (sum, f) => sum + f.totalPrintsPerMonth,
    0
  );

  // Find bottleneck (lowest prints per day per unit)
  const bottleneck = fleet.reduce((min, f) =>
    f.printsPerDayPerUnit < min.printsPerDayPerUnit ? f : min
  );

  // Overall utilization
  const totalAvailableMinutes = fleet.reduce(
    (sum, f) => sum + f.availableMinutesPerDay * f.count,
    0
  );
  const totalPrintingMinutes = fleet.reduce(
    (sum, f) =>
      sum + f.printsPerDayPerUnit * avg_print_time_hours * 60 * f.count,
    0
  );
  const overallUtilization = totalAvailableMinutes > 0
    ? (totalPrintingMinutes / totalAvailableMinutes) * 100
    : 0;

  const lines = [
    `=== Farm Capacity Analysis ===`,
    ``,
    `Fleet: ${totalPrintersCount} printers`,
    `Avg print time: ${avg_print_time_hours}h`,
    `Changeover time: ${changeover_minutes}min`,
    `Print cycle: ${(printCycleMinutes / 60).toFixed(1)}h total`,
    ``,
    `--- Per Printer Type ---`,
    ``,
  ];

  fleet.forEach((f) => {
    lines.push(`${f.printerName} (x${f.count})`);
    lines.push(`   Operating: ${f.hoursPerDay}h/day`);
    lines.push(`   Prints/day/unit: ${f.printsPerDayPerUnit}`);
    lines.push(`   Total prints/day: ${f.totalPrintsPerDay}`);
    lines.push(`   Total prints/month: ${f.totalPrintsPerMonth}`);
    lines.push(`   Utilization: ${f.utilizationPct.toFixed(1)}%`);
    lines.push(``);
  });

  lines.push(`--- Fleet Summary ---`);
  lines.push(``);
  lines.push(`Total daily capacity:   ${totalDailyPrints} prints`);
  lines.push(`Total monthly capacity: ${totalMonthlyPrints} prints`);
  lines.push(`Overall utilization:    ${overallUtilization.toFixed(1)}%`);
  lines.push(``);
  lines.push(`--- Bottleneck ---`);
  lines.push(
    `${bottleneck.printerName} is the constraint at ${bottleneck.printsPerDayPerUnit} prints/day/unit.`
  );

  if (overallUtilization > 85) {
    lines.push(``);
    lines.push(
      `Your farm is running near capacity. Consider adding printers to handle demand spikes.`
    );
  } else if (overallUtilization < 50) {
    lines.push(``);
    lines.push(
      `Your farm has significant spare capacity. Consider extending operating hours or taking on more orders before adding printers.`
    );
  }

  lines.push(``);
  lines.push(
    `Plan your expansion at https://runsodin.com/tools/capacity-planner`
  );

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// -------------------------------------------------------------------
// v2 agent-surface tools (Phase 2). Registered unconditionally —
// they only fail at invocation time if ODIN_BASE_URL / ODIN_API_KEY
// are unset, so the v1 reference-calculator tools continue working
// for pre-sales / standalone use cases without any backend.
// -------------------------------------------------------------------
import { registerReadTools } from "./tools/read_tools.js";
import { registerWriteTools } from "./tools/write_tools.js";
import { registerReferenceTools } from "./tools/reference_tools.js";

registerReadTools(server);
registerWriteTools(server);
registerReferenceTools(server);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // M6: sanitized single-line stderr — no stack, no absolute paths.
  console.error(`[odin-mcp] fatal: ${sanitizeErrorMessage(error)}`);
  process.exit(1);
});

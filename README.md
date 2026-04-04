# ODIN Print Farm MCP Server

An MCP (Model Context Protocol) server that gives AI assistants expert knowledge about 3D print farm management. It provides cost calculators, printer recommendations, farm capacity planning, and software comparison tools — all powered by ODIN's database of 39 printers, 10 filament types, and 6 farm management platforms. Install it in Claude Desktop, Cursor, or any MCP-compatible client to get accurate print farm advice in your AI conversations.

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "odin-print-farm": {
      "command": "npx",
      "args": ["-y", "odin-print-farm-mcp"]
    }
  }
}
```

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "odin-print-farm": {
      "command": "npx",
      "args": ["-y", "odin-print-farm-mcp"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/your-org/odin-mcp.git
cd odin-mcp
npm install
npm run build
npm start
```

## Available Tools

### `calculate_print_cost`

Calculate the true cost of a 3D printed part including material, electricity, machine depreciation, labor, and failure rate.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `printer_model` | string | No | Generic | Printer model name (matched against database) |
| `filament_type` | string | Yes | — | PLA, PETG, ABS, ASA, TPU, or Nylon |
| `filament_cost_per_kg` | number | Yes | — | Filament cost in $/kg |
| `print_weight_grams` | number | Yes | — | Print weight in grams |
| `print_time_hours` | number | Yes | — | Print time in hours |
| `electricity_rate_kwh` | number | No | 0.12 | Electricity rate in $/kWh |
| `labor_rate_per_hour` | number | No | 0 | Labor rate in $/hour |
| `failure_rate_pct` | number | No | 5 | Expected failure rate (%) |

**Example prompt:** "What does it cost to print a 45g PLA part on a Bambu Lab P1S that takes 3 hours?"

### `compare_farm_software`

Compare print farm management platforms (ODIN, SimplyPrint, 3DPrinterOS, OctoPrint, Obico) based on your specific needs.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `printer_count` | number | Yes | — | Number of printers in your farm |
| `protocols_needed` | string[] | No | — | Required protocols (bambu-mqtt, moonraker, prusalink, elegoo-sdcp) |
| `self_hosted_required` | boolean | No | false | Whether self-hosted is required |
| `budget_monthly` | number | No | — | Monthly budget in USD |

**Example prompt:** "Compare farm management software for 12 Bambu Lab printers that needs to be self-hosted."

### `recommend_printer_for_farm`

Get printer recommendations for a farm based on use case, budget, and existing fleet.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `use_case` | string | Yes | — | Primary use (production, prototyping, education, dental, miniatures, cosplay) |
| `budget_per_printer` | number | No | — | Max budget per printer in USD |
| `existing_fleet` | string[] | No | — | Printers already owned |
| `priority` | string | No | reliability | Top priority: speed, quality, reliability, or cost |

**Example prompt:** "Recommend a printer for a production farm with a $700 budget. I already have 5 Bambu P1S printers."

### `estimate_farm_capacity`

Estimate monthly production capacity and identify bottlenecks in your print farm.

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `printers` | array | Yes | — | Fleet: [{model, count, hours_per_day}] |
| `avg_print_time_hours` | number | Yes | — | Average print time in hours |
| `changeover_minutes` | number | No | 15 | Minutes between prints |

**Example prompt:** "I have 4 Bambu X1C running 16 hours/day and 2 Prusa MK4S running 12 hours/day. Average print is 2.5 hours. What's my monthly capacity?"

## Data Coverage

- **39 printers** — Bambu Lab, Prusa, Voron, Creality, Elegoo, QIDI, RatRig, and more
- **10 filament types** — PLA, PETG, ABS, ASA, TPU, Nylon, PC, PLA+, CF-PETG, Resin
- **6 farm platforms** — O.D.I.N., SimplyPrint, 3DPrinterOS, OctoPrint, Obico, Manual

## Links

- **ODIN** — [runsodin.com](https://runsodin.com)
- **Print Cost Calculator** — [runsodin.com/tools/print-cost-calculator](https://runsodin.com/tools/print-cost-calculator)
- **Farm Comparison** — [runsodin.com/compare](https://runsodin.com/compare)
- **Capacity Planner** — [runsodin.com/tools/capacity-planner](https://runsodin.com/tools/capacity-planner)

## License

Apache-2.0

.PHONY: help security security-audit security-secrets security-build security-invariants

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*##"}; {printf "  %-22s %s\n", $$1, $$2}'

security: security-audit security-secrets security-build security-invariants ## Run all security checks

security-audit: ## npm audit --audit-level=moderate
	npm audit --audit-level=moderate

security-secrets: ## Scan for leaked secrets
	npx gitleaks detect --source .

security-build: ## Type-check (catches schema issues)
	npm run build

security-invariants: ## Check source-level invariants from 2026-04-12 adversarial review (M1-M6)
	@echo "==> M1: empty-string printer_model / fleet model must be rejected..."
	@grep -q 'refine((s) => s.length > 0, { message: "printer_model must not be empty' src/index.ts || (echo "FAIL: printer_model schema does not reject empty strings" && exit 1)
	@grep -q 'refine((s) => s.length > 0, { message: "model must not be empty' src/index.ts || (echo "FAIL: fleet model schema does not reject empty strings" && exit 1)
	@grep -q 'refine((s) => s.length > 0, { message: "existing_fleet entries must not be empty' src/index.ts || (echo "FAIL: existing_fleet entries not validated" && exit 1)
	@echo "OK: M1 — empty-string inputs rejected."
	@echo ""
	@echo "==> M2: use_case must be an enum, not free-form text..."
	@grep -q 'use_case: z$$' src/index.ts || grep -q "use_case: z" src/index.ts || (echo "FAIL: use_case not found" && exit 1)
	@grep -A 15 "use_case: z" src/index.ts | grep -qE '\.enum\(\[' || (echo "FAIL: use_case is not z.enum() — still vulnerable to negation smuggling" && exit 1)
	@grep -q 'b.toLowerCase() === use_case.toLowerCase()' src/index.ts || (echo "FAIL: use_case matching still uses substring .includes()" && exit 1)
	@echo "OK: M2 — use_case is enum + exact-match."
	@echo ""
	@echo "==> M3: compare_farm_software must use hard filters, not score nudges..."
	@grep -q 'const eligible = competitors.filter' src/index.ts || (echo "FAIL: no eligibility filter before scoring in compare_farm_software" && exit 1)
	@grep -q 'No compatible platform found' src/index.ts || (echo "FAIL: missing explicit empty-result error from compare" && exit 1)
	@echo "OK: M3 — hard filters + explicit empty-result error."
	@echo ""
	@echo "==> M4: protocols_needed must be normalized and deduped..."
	@grep -q 'Array.from(new Set(arr.filter' src/index.ts || (echo "FAIL: protocols_needed not deduped via Set transform" && exit 1)
	@grep -q 's.toLowerCase().trim()' src/index.ts || (echo "FAIL: protocols_needed strings not normalized" && exit 1)
	@echo "OK: M4 — protocols normalized + deduped."
	@echo ""
	@echo "==> M5: empty candidate set must return explicit error..."
	@grep -q 'NO_FEASIBLE_SOLUTION' src/index.ts || (echo "FAIL: empty candidate set does not return NO_FEASIBLE_SOLUTION" && exit 1)
	@echo "OK: M5 — empty budget results return explicit error."
	@echo ""
	@echo "==> M6: stderr must be sanitized..."
	@grep -q 'function sanitizeErrorMessage' src/index.ts || (echo "FAIL: sanitizeErrorMessage helper missing" && exit 1)
	@! grep -q '"Fatal error:", error' src/index.ts || (echo "FAIL: main catch still logs raw error object" && exit 1)
	@grep -q '\[odin-mcp\] fatal:' src/index.ts || (echo "FAIL: fatal log doesn't use sanitized format" && exit 1)
	@echo "OK: M6 — stderr redacts paths and stack frames."
	@echo ""
	@echo "==> All M1-M6 invariants hold."

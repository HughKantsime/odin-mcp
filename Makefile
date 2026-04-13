.PHONY: help security security-audit security-secrets security-build

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*##"}; {printf "  %-20s %s\n", $$1, $$2}'

security: security-audit security-secrets security-build ## Run all security checks

security-audit: ## npm audit --audit-level=moderate
	npm audit --audit-level=moderate

security-secrets: ## Scan for leaked secrets
	npx gitleaks detect --source .

security-build: ## Type-check (catches schema issues)
	npm run build

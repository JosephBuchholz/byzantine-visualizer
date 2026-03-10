ALG_DIR := ./algorithm

format:
	npm run fmt --prefix $(ALG_DIR)
	npm run lint:fix --prefix $(ALG_DIR)

.PHONY: fmt-lint
fmt-lint:
	npm run fmt:check --prefix $(ALG_DIR)
	npm run lint --prefix $(ALG_DIR)

.PHONY: test
test:
	npm run test --prefix $(ALG_DIR)
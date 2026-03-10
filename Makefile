ALG_DIR := ./algorithm

format:
	npm run fmt --prefix $(ALG_DIR)
	npm run lint:fix --prefix $(ALG_DIR)

format-check:
	npm run fmt:check --prefix $(ALG_DIR)
	npm run lint --prefix $(ALG_DIR)

test:
	npm run test --prefix $(ALG_DIR)
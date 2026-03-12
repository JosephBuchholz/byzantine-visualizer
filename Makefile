ALG_DIR := ./algorithm
VIS_DIR := ./visual

install:
	npm install --prefix $(ALG_DIR)
	npm install --prefix $(VIS_DIR)

format:
	npm run fmt --prefix $(ALG_DIR)
	npm run lint:fix --prefix $(ALG_DIR)
	npm run format --prefix $(VIS_DIR)
	npm run lint:fix --prefix $(VIS_DIR)

format-check:
	npm run fmt:check --prefix $(ALG_DIR)
	npm run lint --prefix $(ALG_DIR)
	npm run format:check --prefix $(VIS_DIR)
	npm run lint --prefix $(VIS_DIR)

build:
	npm run build --prefix $(ALG_DIR)
	npm run build --prefix $(VIS_DIR)

test:
	npm run test --prefix $(ALG_DIR)
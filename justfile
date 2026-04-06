# Wine Search Engine — task runner (https://just.systems)
# Run `just` or `just --list` to see recipes. Full scripts: package.json, CLAUDE.md

# Default: show available recipes
default:
    @just --list

# Fastify API — tsx watch (loads .env via app)
alias d := dev
dev:
    npm run dev

build:
    npm run build

start:
    npm run start

typecheck:
    npm run typecheck

lint:
    npm run lint

lint-fix:
    npm run lint:fix

test:
    npm run test

test-watch:
    npm run test:watch

test-integration:
    npm run test:integration

test-e2e-contract:
    npm run test:e2e:contract

test-e2e-runtime:
    npm run test:e2e:runtime

verify-http-contracts:
    npm run verify:http-contracts

# Husky pre-push gate (typecheck + unit + HTTP contract parity)
prepush:
    npm run git:prepush

prepush-quick:
    npm run git:prepush:quick

migrate:
    npm run migrate

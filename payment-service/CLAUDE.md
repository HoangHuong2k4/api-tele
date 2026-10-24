# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Setup
```bash
# Install dependencies
pnpm install

# Install Playwright browsers
pnpm playwright install

# Start development dependencies (Redis + Captcha resolver)
docker-compose -f docker-compose.dev.yml up -d
```

### Development
```bash
# Start in development mode with watch
pnpm run start:dev

# Start in debug mode
pnpm run start:debug

# Build the application
pnpm run build

# Start production build
pnpm run start:prod
```

### Testing
```bash
# Run unit tests
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Run tests with coverage
pnpm run test:cov

# Run e2e tests
pnpm run test:e2e

# Debug tests
pnpm run test:debug
```

### Code Quality
```bash
# Lint and fix
pnpm run lint

# Format code
pnpm run format
```

## Architecture Overview

This is a NestJS-based payment service that monitors Vietnamese bank accounts and USDT blockchain transactions, providing webhooks and notifications when payments are received.

### Core Components

- **Gateways Module**: Payment gateway implementations for different banks and blockchains
- **Payments Module**: Main payment processing and API endpoints  
- **Bots Module**: Telegram and Discord notification bots
- **Webhook Module**: HTTP webhook delivery system
- **Proxy Module**: Proxy management for bank requests
- **Captcha Solver Module**: CAPTCHA resolution service

### Gateway Architecture

The service uses a factory pattern for payment gateways:

- **GateFactory** (`src/gateways/gateway-factory/gate.factory.ts`): Creates gateway instances
- **Gate** base class: Abstract class all gateways extend from
- **Supported Gateways**: VCB, TP Bank, MB Bank, ACB Bank, Tron USDT, BEP20 USDT

Each gateway implements the `getHistory()` method to fetch transaction history from their respective APIs.

### Configuration

- Uses YAML configuration in `config/config.yml`
- Environment variables validated with Joi schema in `app.module.ts:20-30`
- Required env vars: `REDIS_HOST`, `REDIS_PORT`, `CAPTCHA_API_BASE_URL`

### Queue System

- Uses BullMQ with Redis for job processing
- Queue UI available at `/admin/queues` endpoint
- Middleware configured in `src/shards/middlewares/queues.middleware.ts`

## Development Notes

- Service runs on port 3000 by default (configurable via PORT env var)
- Redis cache is used to store transaction history and prevent duplicates
- Clear Redis cache with: `docker-compose exec redis redis-cli flushall`
- Each gateway polls at configurable intervals (`repeat_interval_in_sec`)

## Adding New Gateways

1. Create service class in `src/gateways/gateway-factory/[name].services.ts`
2. Extend `Gate` base class and implement `getHistory()` method
3. Add new type to `GateType` enum in `gate.interface.ts`
4. Register in factory switch statement in `gate.factory.ts`
5. Update validation schema in `gates-manager.services.ts`
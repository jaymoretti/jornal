# jornal.cc

A personal RSS and Atom dashboard: bento-grid feed blocks, an ad-free reader, and a
Cloudflare Worker that does feed parsing and article extraction.

## Stack

Vite + React 19 + TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), Biome for lint/format,
self-hosted `@fontsource` fonts. The API is a Cloudflare Worker (`src/worker.ts`) built from
framework-agnostic Fetch handlers in `src/api/`.

## Setup

```bash
npm install
npm test          # node --test on src/lib/*.test.ts (10 tests)
npm run lint      # biome check
```

## Dev

Two processes: Vite serves the UI with HMR and proxies `/api/*` to the Worker.

```bash
portless proxy start --https   # once per machine
portless jornal-api npm run preview   # Worker + /api
portless jornal-ui  npm run dev       # UI, use the URL it prints
```

Without portless, the same thing on fixed ports: `npm run preview` (wrangler on 8787) and
`npm run dev` (vite on 5173). `portless` is installed globally, never as a project dependency;
it injects the port via `PORT`, so the vite proxy default of 8787 only applies when you start
the Worker yourself. If portless gives the Worker a different port, point the proxy at it:

```bash
API_ORIGIN=https://jornal-api.localhost npm run dev
```

## Build

```bash
npm run build     # tsc --noEmit && vite build -> dist/
npm run preview   # wrangler dev serves dist/ + the Worker on one origin (production-shaped)
```

## Deploy

```bash
npm run build && npx wrangler deploy
```

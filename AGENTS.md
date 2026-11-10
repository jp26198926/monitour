# AGENTS.md — Monitour

> Instructions for AI agents working on the Monitour codebase.
> Read this before making changes. When you detect a new version/update, **ask the user** before proceeding.

---

## What is Monitour?

A MeshCentral-inspired **remote monitoring & management** platform. Admins see remote devices in a web dashboard, view their screens in real-time, take control (mouse/keyboard), open terminals, and transfer files.

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js 20+, Express 5, Mongoose, Socket.IO |
| Dashboard | React 19, Vite 6, TypeScript, zustand |
| Agent | Electron 35, Node.js, `screenshot-desktop`, `@nut-tree-fork/nut-js`, `node-pty` |
| Database | MongoDB |
| Auth | JWT (user + device), RSA cert pinning |
| Protocol | REST + Socket.IO (binary frames) |

## Project Structure

```
monitour/
├── shared/          # Protocol types shared by all 3 packages
│   └── src/protocol.ts   # ALL message types live here
├── server/          # Express 5 + MongoDB + Socket.IO
│   └── src/
│       ├── index.ts          # Entry point
│       ├── config.ts         # Zod-validated env config
│       ├── db/models/        # User, Device, EnrollmentToken (Mongoose)
│       ├── auth/             # JWT + middleware
│       ├── routes/           # REST: auth, devices, enrollment
│       ├── socket/           # Socket.IO: agentHandler, dashboardHandler
│       └── certs/certOps.ts  # PKI generation + SHA-256 pinning
├── dashboard/       # React + Vite web UI
│   └── src/
│       ├── pages/            # Login, Devices, DeviceDetail, RemoteDesktop, Settings
│       ├── components/       # DashboardLayout
│       ├── store/            # zustand stores (auth, devices)
│       └── api/client.ts     # Fetch wrapper with JWT
├── agent/           # Electron desktop agent
│   └── src/main/
│       ├── electron.ts       # Electron entry (GUI window)
│       ├── index.ts          # CLI entry (headless)
│       ├── connection.ts     # Socket.IO client + command dispatcher
│       ├── enrollment.ts     # RSA keypair + cert pinning
│       ├── screenCapture.ts  # Screenshot capture
│       ├── inputInjector.ts  # Mouse/keyboard injection (nut.js)
│       ├── terminal.ts       # node-pty terminal
│       ├── fileTransfer.ts   # File ops (path-traversal guarded)
│       └── src/renderer/     # Electron GUI (enrollment form + status)
└── deploy/          # PM2, Nginx, deployment docs
```

## How to Run

```bash
# Install all workspaces
npm install

# Build shared protocol types (must be first)
npm run build:shared

# Terminal 1: Server (requires MongoDB running)
cd server && npm run dev       # http://localhost:4430

# Terminal 2: Dashboard
cd dashboard && npm run dev    # http://localhost:3000

# Terminal 3: Agent (GUI)
cd agent && npm run dev        # Electron window opens
```

## Key Architectural Patterns

### 1. Protocol Types (`shared/src/protocol.ts`)
**ALL message types live here.** Never duplicate a type in server/dashboard/agent. If you add a new event or payload shape, add it to `protocol.ts` first, then use it everywhere.

### 2. Socket.IO Namespaces
- `/agent` — agents connect with device JWT (`auth.token`)
- `/dashboard` — browsers connect with user JWT (`auth.token`)
- Commands flow: **Dashboard → Server → Agent** via `dash:send-command` → `server:command`
- Results flow: **Agent → Server → Dashboard** via `agent:command-result` → `dash:command-result`
- Frames flow: **Agent → Server → Dashboard** via `agent:frame` → `device:frame-update`
- Thumbnails: **Agent → Server → Dashboard** via `agent:thumbnail` → `device:thumbnail-update`
- Input: **Dashboard → Server → Agent** via `dash:desktop-input` → `server:desktop-input`

### 3. Device Authentication
- Agent generates RSA-2048 keypair on first run
- Enrolls with a one-time token → receives `deviceToken` (JWT) + `serverCertHash`
- Server generates cert hierarchy (root CA → agent cert + web cert) on first run
- Agents pin the server's agent-cert SHA-256 hash

### 4. Remote Desktop
- **View-only by default** — input events are gated behind `controlEnabled` state
- Frames are JPEG screenshots via `screenshot-desktop`, streamed over Socket.IO
- Input injection via `@nut-tree-fork/nut-js` (async event queue)
- Coordinate mapping: percentage (0–100) → screen pixels

### 5. Thumbnails
- Agent sends low-res thumbnails (320px, quality 30) every 5 seconds
- Server stores latest per device in memory (`thumbnailStore`)
- Dashboard shows them in grid view on the Devices page

## Code Conventions

### TypeScript
- **Strict mode** everywhere
- Use `import type` for type-only imports
- ESM modules (`"type": "module"` in all packages)
- Shared types go in `shared/src/protocol.ts`, never inline

### React
- Function components only (no classes)
- zustand for global state, `useState` for local
- CSS in `global.css` (no CSS modules, no styled-components)
- Use existing CSS classes: `.card`, `.btn`, `.data-table`, `.status-dot`, etc.

### Server
- Express 5 async error handling (no `next(err)` needed)
- Mongoose models in `db/models/`, aggregated in `db/index.ts`
- Socket.IO handlers in `socket/`, one file per namespace
- All env config through `config.ts` (Zod-validated)

### Agent
- Native modules: `screenshot-desktop`, `@nut-tree-fork/nut-js`, `node-pty`
- GUI mode: `electron.ts` + `src/renderer/` (HTML/CSS/JS, no framework)
- CLI mode: `index.ts` (headless)
- `inputInjector.ts` handles all OS-level input — never call nut.js directly elsewhere

## Commands

| Command | What it does |
|---|---|
| `npm run dev` (root) | Starts server + dashboard in parallel |
| `npm run build` (root) | Builds shared + server + dashboard |
| `npm run dev` (server) | `tsx watch src/index.ts` |
| `npm run dev` (dashboard) | Vite dev server |
| `npm run dev` (agent) | Builds TS + launches Electron GUI |
| `npm run dev:cli` (agent) | Headless agent (no GUI) |
| `npx tsc` (any package) | TypeScript compile |

## Common Tasks

### Adding a new Socket.IO event
1. Add the event name + payload type to `shared/src/protocol.ts`
2. Emit/listen in the appropriate `socket/*.ts` handler
3. Use the shared type in the consumer (dashboard or agent)

### Adding a new REST endpoint
1. Add request/response types to `shared/src/protocol.ts`
2. Add route to `server/src/routes/*.ts`
3. Use `api.get/post/patch/delete` in dashboard

### Adding a new command type
1. Add to `CommandType` union in `shared/src/protocol.ts`
2. Handle in `agent/src/main/connection.ts` `handleCommand()`
3. Send from dashboard via `sendCommand()`

## Testing Checklist

After any change, verify:
1. `npx tsc` passes in all 4 packages (shared, server, dashboard, agent)
2. Server starts without errors (`cd server && npm run dev`)
3. Dashboard loads at `http://localhost:3000`
4. Agent connects and shows device in dashboard
5. Remote desktop: view-only works, Control toggle enables input
6. Thumbnails appear in grid view on Devices page

## Important Notes

- **`node_modules` is hoisted to root** (npm workspaces) — this is expected
- **MongoDB must be running** before starting the server
- **`server/data/`** contains the cert hierarchy — back it up; losing it means re-enrolling all agents
- **`@nut-tree-fork/nut-js`** is the input injection library (not `robotjs`, not `@nut-tree/nut-js`)
- The `screenCapture.ts` `startCapture()` uses a **singleton interval** — only one capture loop at a time. Use `captureFrame()` directly for independent captures (like thumbnails).

## Update Protocol

**When you detect a version change, new dependency, or structural update to this project, ASK the user before making assumptions about the changes.** This includes:
- Package version bumps
- New files or directories appearing
- Changes to `shared/src/protocol.ts`
- Changes to the Socket.IO event contract
- Changes to the database schema

Do not silently adapt to changes — confirm with the user first.

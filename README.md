# Monitour

Monitour lets you manage remote devices from a web dashboard — view their screens in real-time, take remote desktop control, open a terminal, transfer files, and organize devices into groups.

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│   Browser   │◄──REST──►│  Monitour Server  │◄──WS────►│  Agent (Electron)│
│  (React)    │         │  (Node.js/Express)│         │  on device      │
│             │◄──WS────►│                   │         │                │
└─────────────┘         │  MongoDB          │         └──────────────┘
                        └──────────────────┘
```

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express 5 |
| Database | MongoDB + Mongoose |
| Dashboard | React + Vite |
| Desktop agent | Electron + Node.js |
| Real-time | Socket.IO |
| Remote desktop | Screenshot-frame streaming + input injection |
| Authentication | JWT + device credentials (cert pinning) |
| Deployment | Ubuntu + PM2 + Nginx |
| Packaging | Electron Builder |

## Features

### Dashboard
- **Device management** — list, edit, delete devices
- **Device groups** — organize devices with named groups
- **Search & filter** — search by name/hostname/alias, filter by group or status
- **Live thumbnails** — grid view with real-time screen previews
- **Remote desktop** — view-only by default, toggle **Control** for mouse/keyboard
- **View mode** — switch between table and grid views
- **Alias names** — custom display names for devices
- **Enrollment modes** — locked (token required) or open (no token)

### Agent
- **Electron GUI** — enrollment form, status display, settings
- **System service** — install as Windows service / systemd / launchd with auto-run
- **Settings password** — protect configuration with bcrypt password
- **Auto-update** — check for and apply updates from the server
- **Real-time status** — online/offline, device info, last seen
- **Remote desktop** — screen capture, mouse/keyboard injection
- **Terminal** — full PTY terminal access
- **File transfer** — browse, upload, download files
- **Auto-recovery** — detects device deletion and prompts re-enrollment

### Security
- Passwords hashed with bcrypt (12 rounds)
- JWT tokens (24h for users, 365d for devices)
- Agents pin the server's agent-auth certificate (SHA-256)
- One-time enrollment tokens (or open enrollment mode)
- File access restricted to home directory
- Settings password protection on the agent

## Quick Start

### Prerequisites
- Node.js 20+
- MongoDB 6+ (running locally or remote)
- npm 10+

### Install & Build

```bash
git clone <repo-url> monitour
cd monitour
npm install
npm run build:shared
```

### Start the Server

```bash
cd server
cp .env.example .env
# Edit .env — set JWT_SECRET and MONGO_URI
npm run dev
```

Server starts on `http://localhost:4430`.

### Start the Dashboard

```bash
cd dashboard
npm run dev
```

Dashboard runs on `http://localhost:3000` (proxied to server).

### Create Admin Account

Open `http://localhost:3000`, click **Create Account** — the first user becomes admin.

### Enroll a Device

1. Go to **Settings** → create an **Enrollment Token** (or switch to **Open** mode)
2. Copy the token
3. On the target machine, run the agent:

```bash
cd agent
export MONITOUR_SERVER_URL=http://your-server:4430
export MONITOUR_ENROLLMENT_TOKEN=<your-token>
npm run dev
```

Or use the GUI — the agent opens an enrollment window where you can paste the server URL and token.

### Remote Desktop

Click **Connect** on any online device. You'll see the screen in **View Only** mode. Click **Control** to enable mouse/keyboard input.

## Project Structure

```
monitour/
├── shared/          # Protocol types shared by all components
├── server/          # Express 5 + MongoDB + Socket.IO backend
├── dashboard/       # React + Vite web dashboard
├── agent/           # Electron desktop agent
├── deploy/          # PM2, Nginx, and deployment configs
└── docs/            # Additional documentation
```

## Protocol Overview

- **REST API** (`/api/*`): auth, device CRUD, enrollment, groups, settings, updates
- **Socket.IO** (`/agent`, `/dashboard`): real-time control channel
- **Device auth**: RSA keypair + cert pinning
- **Frames**: JPEG screenshots streamed via Socket.IO
- **Input**: mouse/keyboard events via Socket.IO → nut.js injection

## Deployment (Ubuntu)

See [deploy/README.md](deploy/README.md) for full PM2 + Nginx setup.

```bash
cd server
NODE_ENV=production JWT_SECRET=<secret> MONGO_URI=<uri> npm run build && npm run start
```

## Agent Service Installation

The agent can run as a system service for auto-start on boot:

1. Open the agent GUI
2. Click **Install as Service (Auto-run)**
3. Approve the UAC prompt (Windows)

Or for headless/server deployment, use the CLI entry point:
```bash
cd agent
npm run dev:cli
```

## Agent Settings Password

Protect the agent configuration from unauthorized changes:

1. Open the agent GUI
2. In **Settings Password**, enter a new password
3. Click **Set Password**
4. Changing/removing the password or resetting the agent now requires this password

## Auto-Update

The agent checks for updates every 6 hours and on connect:

1. Place update packages in `server/updates/`
2. Update `server/updates/manifest.json` with version info
3. Agents detect the new version and prompt to update

## License

Apache-2.0

# OpenCode × Feishu Bridge (opencode-lark)

[![OpenCode v2](https://img.shields.io/badge/OpenCode-v2.1.1-3178C6)]()
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**[中文](README.md) | [English](README-en.md)**

---

> **opencode-lark** is a bridge service that connects **OpenCode (v2)** to **Feishu (Lark)**.
> It is a refactor of [opencode-bridge](https://github.com/HNGM-HP/opencode-bridge) 2.9.52: the underlying communication was migrated from the `@opencode-ai/sdk` (v1 API) to **opencode 2.x `/api/*` HTTP endpoints and the new event model**.

---

## ⚠️ Supported Platforms

This bridge **only supports Feishu (Lark)**. Other instant messaging platforms are out of scope for this project.

---

## ✨ Features

### 🔄 Session Management (Feishu)
- Each group/DM binds to an independent OpenCode session
- Session bind, migrate, rename, cross-device handoff
- `/sessions` session picker: filter by project directory, tap to bind
- Multi-project directories and aliases

### 🤖 AI Interaction
- **Streaming output** with thinking-chain display
- **Permission cards**: approve / deny / always-allow right in Feishu
- **Question cards**: tap options to answer (like CLI 1/2/3)
- **Model picker**: `/panel` filters models by provider, **free models (`*free`) on top by default**
- **File transfer**: AI can send files/screenshots to Feishu

### 🛡️ Reliability
- Heartbeat monitoring of OpenCode health
- Auto-rescue: restarts OpenCode on crash
- Runtime cron jobs
- Audit logging

### 🎛️ Web Admin Panel
- Visual configuration at `http://localhost:4098`
- Platform status, cron management, logs, remote restart

---

## 🚀 Quick Start (Feishu)

### 1. Start OpenCode v2 server

```bash
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD=your_password
opencode serve --hostname 0.0.0.0 --port 4096
```

### 2. Clone & install

```bash
git clone https://github.com/Confusedisprecious/opencode-lark.git
cd opencode-lark
npm install
```

### 3. Configure Feishu

```bash
cp .env.example .env
```

Edit `.env`:

```
FEISHU_ENABLED=true
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
OPENCODE_HOST=localhost
OPENCODE_PORT=4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your_password
```

Feishu app requirements:
- Bot capability enabled
- Event subscription via **long connection** (no public webhook needed)
- Permissions: `im:message`, `im:message.group_at_msg`, etc.

See [Feishu configuration doc](assets/docs/feishu-config.md) for details.

### 4. Build & start

```bash
npm run build
npm run start
```

---

## 📝 Common Commands (Feishu)

| Command | Description |
|---------|-------------|
| `/sessions` | Open session picker (filter by project directory, tap to bind) |
| `/session new [dir]` | Create a new session |
| `/session <sessionID>` | Switch/bind to a session |
| `/panel` | Control panel (stop/undo, provider+model dropdowns, role dropdown) |
| `/model <provider>:<model>` | Switch model directly |
| `/project list` | List available project directories |
| `/effort <low\|high\|max>` | Set reasoning effort |
| `/clear` | Clear current session context |

---

## 🏗️ Architecture

```
Feishu client ── long connection / cards ──▶ Bridge ── HTTP /api/* ──▶ opencode v2 serve
                                                 │
                                                 ├─ event stream (/api/event) → internal events
                                                 ├─ permission / form / session / model handling
                                                 └─ Web admin panel (:4098)
```

Key modules:
- `src/opencode/client.ts`: opencode v2 HTTP client (replaces `@opencode-ai/sdk`)
- `src/opencode/types.ts`: local type layer (aligned with v2 API)
- `src/feishu/`: Feishu messages, cards, streaming
- `src/router/`: event hub, permission/form action dispatch
- `src/reliability/`: heartbeat, cron, crash rescue

---

## 📚 Docs

| Doc | Description |
|-----|-------------|
| [Feishu config](assets/docs/feishu-config.md) | Feishu event subscription & permissions |
| [Environment](assets/docs/environment.md) | Full configuration reference |
| [Deployment](assets/docs/deployment.md) | Deployment & upgrade |
| [Reliability](assets/docs/reliability.md) | Heartbeat, cron, crash rescue |

---

## 📋 Requirements

- Node.js >= 18
- opencode v2 (>= 2.1.0)
- A Feishu custom app with bot capability

---

## 📄 License

[GPL-3.0](LICENSE). Forked from [opencode-bridge](https://github.com/HNGM-HP/opencode-bridge).

---

## 🤝 Contributing

Issues & PRs are welcome, especially **opencode v2 adaptation** fixes.
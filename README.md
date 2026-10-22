# OpenCode × 飞书桥接（opencode-lark）

[![OpenCode v2](https://img.shields.io/badge/OpenCode-v2.1.1-3178C6)]()
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**[中文](README.md) | [English](README-en.md)**

---

> **opencode-lark** 是一个将 **OpenCode（v2）** 接入 **飞书（Lark）** 的桥接服务。
> 本项目基于 [opencode-bridge](https://github.com/HNGM-HP/opencode-bridge) 2.9.52 重构，将底层通信从 `@opencode-ai/sdk`（v1 API）替换为 **opencode 2.x 的 `/api/*` HTTP 接口与新版事件模型**。

---

## ⚠️ 支持范围声明

| 平台 | 状态 |
|------|------|
| **飞书（Lark）** | ✅ **完整支持（推荐）** |
| Discord / 企业微信 / Telegram / QQ / WhatsApp / 个人微信 / 钉钉 | ⚠️ **未在 opencode v2 下验证** |

> **重要**：本项目只保证**飞书**平台可用。其他平台的适配器代码继承自原项目，但在本次 opencode v2 重构中**没有经过验证**，可能无法正常工作，请勿在生产环境使用。

---

## ✨ 核心特性

### 🔄 会话管理（飞书）
- 每个群聊/私聊独立绑定 OpenCode 会话，上下文互不干扰
- 会话绑定、迁移、重命名，跨设备接力
- `/sessions` 会话选择器：按项目目录下拉筛选，直接点选绑定
- 多项目目录支持、项目别名配置

### 🤖 AI 交互能力
- **流式输出**：实时显示 AI 响应，支持思考链展示
- **权限交互**：AI 权限请求直接在飞书卡片内点「允许/拒绝/始终允许」
- **问题回答**：AI 提问在飞书卡片内直接点击选项作答（类似 CLI 的 1/2/3）
- **模型选择**：`/panel` 面板按厂商下拉筛选，**免费模型（`*free`）默认置顶**
- **文件传输**：AI 可将文件/截图发送到飞书

### 🛡️ 可靠性保障
- 心跳监控：定时探测 OpenCode 健康状态
- 自动救援：OpenCode 宕机时自动重启恢复
- Cron 任务：运行时动态管理定时任务
- 日志审计：完整的操作日志与错误追踪

### 🎛️ Web 管理面板
- 浏览器实时修改配置参数（`http://localhost:4098`）
- 查看各平台连接状态、管理 Cron、查看日志、远程重启

---

## 🚀 快速开始（飞书）

### 1. 启动 OpenCode v2 服务

```bash
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD=your_password
opencode serve --hostname 0.0.0.0 --port 4096
```

> 需要先安装 opencode v2（`npm i -g @opencode/cli` 或官方安装方式）。

### 2. 克隆并安装

```bash
git clone https://github.com/Confusedisprecious/opencode-lark.git
cd opencode-lark
npm install
```

### 3. 配置飞书

```bash
cp .env.example .env
```

编辑 `.env`，填入飞书机器人配置：

```
FEISHU_ENABLED=true
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
OPENCODE_HOST=localhost
OPENCODE_PORT=4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your_password
```

飞书后台需要配置：
- 应用能力：机器人
- 事件订阅：使用**长连接**模式（无需公网回调地址）
- 权限：`im:message`、`im:message.group_at_msg` 等读写权限

完整飞书配置说明见 [飞书配置文档](assets/docs/feishu-config.md)。

### 4. 构建并启动

```bash
npm run build
npm run start
```

启动后即可在飞书群里 @机器人 使用。

---

## 📝 飞书常用命令

| 命令 | 说明 |
|------|------|
| `/sessions` 或 `/session` | 打开会话选择器（按项目目录下拉，点选绑定） |
| `/session new [目录]` | 创建新会话 |
| `/session <会话ID>` | 切换/绑定到指定会话 |
| `/panel` | 打开控制面板（停止/撤回、厂商+模型下拉、角色下拉） |
| `/model <厂商>:<模型>` | 直接切换模型 |
| `/project list` | 查看可用项目目录 |
| `/project default set <路径>` | 设置群默认项目 |
| `/effort <low\|high\|max>` | 设置推理强度 |
| `/clear` | 清除当前会话上下文 |

---

## 🏗️ 架构概览

```
飞书客户端 ── 长连接/卡片 ──▶ 本桥接服务 ── HTTP /api/* ──▶ opencode v2 serve
                                  │
                                  ├─ 事件流订阅（/api/event）→ 翻译为桥接内部事件
                                  ├─ 权限/问答/会话/模型管理
                                  └─ Web 管理面板（:4098）
```

核心模块：
- `src/opencode/client.ts`：opencode v2 HTTP 客户端（替代旧 `@opencode-ai/sdk`）
- `src/opencode/types.ts`：本地类型层（对齐 v2 API）
- `src/feishu/`：飞书消息、卡片、流式输出
- `src/router/`：事件中心、权限/问答动作分发
- `src/reliability/`：心跳、Cron、宕机救援

---

## 🔧 配置说明

- `.env` 文件：飞书与 OpenCode 连接参数（见 `.env.example`）
- Web 管理面板：`http://localhost:4098` 可视化配置
- 完整配置参数见 [配置中心文档](assets/docs/environment.md)
- 部署运维见 [部署文档](assets/docs/deployment.md)

---

## 📚 文档导航

| 文档 | 说明 |
|------|------|
| [飞书配置](assets/docs/feishu-config.md) | 飞书事件订阅与权限配置 |
| [配置中心](assets/docs/environment.md) | 完整配置参数说明 |
| [部署运维](assets/docs/deployment.md) | 部署、升级说明 |
| [可靠性指南](assets/docs/reliability.md) | 心跳、Cron 与宕机救援 |

> 其他平台（Discord/企业微信/Telegram/QQ/WhatsApp/微信/钉钉）的文档保留在原仓库，仅供参考，**未经 v2 验证**。

---

## 📋 环境要求

- Node.js >= 18
- opencode v2（≥ 2.1.0）
- 飞书自建应用（机器人）

---

## 📄 许可证

本项目基于 [GPL-3.0](LICENSE) 开源，继承自 [opencode-bridge](https://github.com/HNGM-HP/opencode-bridge)。

---

## 🌟 贡献与反馈

- 欢迎提交 Issue / PR，特别是 **opencode v2 适配** 相关的修复
- 如需接入其他平台，请在验证后补充文档与测试
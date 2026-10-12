# Antigravity Task Timer & Metrics Monitor (反重力任务执行耗时与 Token 指标监控)

<p align="center">
  <b>Google Antigravity 桌面客户端专属：实时任务执行计时胶囊、Tokens 统计与缓存命中监控插件</b><br>
  <i>零侵入、零宽度占用、精准绑定当前窗口、Consolas 极客排版风格</i>
</p>

---

## ✨ 核心特性

- ⏱️ **顶栏极简微型计时胶囊**：常驻于客户端顶栏，实时呈现 `● 执行中 01:23` 动态绿点呼吸灯与 Consolas 等宽数字排版，0 占用主编辑区与会话区宽度。
- 🎯 **当前会话精准锁定**：深度基于 `window.location` 路由 `/c/<uuid>` 绑定当前会话窗口，多窗口/多任务高并发时绝不串台，彻底消除焦点切换时的秒表横跳。
- 📊 **三维指标卡片**：
  - **38px 极客风秒表**：高辨识度绿色发光大号实时秒表，附带任务发起时间与 `[指令]` 耗时标签。
  - **实时步骤与动作**：直观展示 Agent 当前正在执行的工具动作（如 `⚡ search_web`）或思考状态。
  - **Token 消耗与缓存命中**：实时统计本轮交互的 **步骤数**、**输出 Tokens** 与 **Prompt 缓存命中数 (Cache Hit)**。
- ⚡ **零重启热重载**：支持基于 Chrome DevTools Protocol (CDP) 的动态热注入与 ASAR 主世界持久化。

---

## 🚀 快速安装

### 方式一：一键脚本 (推荐)
直接双击运行本仓库目录下的 `install.bat`，即可全自动完成检测、备份与补丁注入。

### 方式二：命令行安装
```bash
# 进入项目目录并安装
node bin/cli.js install

# 或者在客户端运行中执行零重启热加载
node bin/cli.js hot-reload
```

---

## 🛠️ 命令参考

| 命令 | 说明 |
| :--- | :--- |
| `node bin/cli.js install` | 解构 `app.asar` 并持久化写入主世界注入包装体 |
| `node bin/cli.js hot-reload` | 通过 WebSocket / CDP 向运行中的 Antigravity 注入最新脚本 |
| `node bin/cli.js restore` | 从 ASAR 中卸载任务计时器补丁 |

---

## 📐 架构设计

```
Google Antigravity Desktop Client
│
├── dist/preload.js (ContextBridge)
│   └── // --- Antigravity Task Timer Start ---
│       └── WebFrame.executeJavaScript -> task-timer-widget.js
│
└── Main World DOM
    ├── #agy-task-timer-topbar (顶部顶栏胶囊)
    │   ├── ● 绿色呼吸微动效点 (CSS Keyframes)
    │   └── Consolas 状态与秒表文本
    └── #agy-task-popover (悬浮详情卡片)
        ├── 大号极客秒表 (38px #22c55e)
        ├── 步骤与当前工具调用显示
        └── 步骤数 / 输出 Tokens / 缓存命中数据栅格
```

---

## 📄 开源许可

本项目基于 [MIT 许可](LICENSE) 开源发布。

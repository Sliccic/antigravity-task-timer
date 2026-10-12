/**
 * Antigravity Real-Time Session Task Execution Timer & Metrics Indicator
 * Google 反重力桌面客户端任务耗时胶囊、Tokens 统计与缓存命中监控插件
 * 
 * 核心特性：
 * 1. 顶部标题栏实时任务胶囊：显示执行状态与动态秒级秒表 (● 执行中 01:23)
 * 2. 精准绑定【当前会话窗口】：基于 window.location 路由深度锁定当前会话，多任务并发不串台、不横跳
 * 3. 悬浮窗详情展示：Consolas 极客风大号秒表、输出 Tokens、缓存命中 (Cache Hit)、输入 Tokens、步骤数与当前工具调用
 * 4. 0 占用主编辑区与会话区水平宽度，悬停预览，点击锁定，点击外部平滑收起
 */
(function initAntigravityTaskTimerWidget() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 清理旧实例与旧 DOM 节点，确保热更新无缝生效
  const removeEl = (id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  };
  removeEl('agy-task-timer-topbar');
  removeEl('agy-task-popover');

  if (window.__AGY_TASK_TIMER_INITIALIZED__) {
    if (window.__AGY_TASK_TIMER_CLEANUP__) {
      try { window.__AGY_TASK_TIMER_CLEANUP__(); } catch (_) {}
    }
  }

  // 唯一实例 ID 守卫：使旧实例在下一次循环时自动静默退出，彻底根除多版本/旧闭包争抢 DOM
  const WIDGET_INSTANCE_ID = 'agy_task_inst_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  window.__AGY_TASK_ACTIVE_INSTANCE_ID__ = WIDGET_INSTANCE_ID;

  if (window.__AGY_TASK_TICK_TIMER__) {
    clearInterval(window.__AGY_TASK_TICK_TIMER__);
    window.__AGY_TASK_TICK_TIMER__ = null;
  }
  if (window.__AGY_TASK_POLL_TIMER__) {
    clearInterval(window.__AGY_TASK_POLL_TIMER__);
    window.__AGY_TASK_POLL_TIMER__ = null;
  }

  window.__AGY_TASK_TIMER_INITIALIZED__ = true;

  // 字体栈（适配 Windows Consolas 与现代等宽无衬线体）
  const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const FONT_MONO = 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace';

  // 注入微型柔和呼吸动效样式
  if (typeof document !== 'undefined' && !document.getElementById('agy-task-pulse-style')) {
    const s = document.createElement('style');
    s.id = 'agy-task-pulse-style';
    s.textContent = `
      @keyframes agy-task-pulse-dot {
        0%, 100% { opacity: 0.85; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.12); box-shadow: 0 0 7px rgba(34,197,94,0.9); }
      }
    `;
    document.head.appendChild(s);
  }

  // 用户持久化配置
  const CONFIG_STORAGE_KEY = 'agy_task_timer_config';
  const DEFAULT_CONFIG = {
    triggerMode: 'hover', // 'click' | 'hover'
    timeStyle: 'zh'
  };

  let config = loadConfig();

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (raw) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
    } catch (_) {}
    return Object.assign({}, DEFAULT_CONFIG);
  }

  // =========================================================================
  // 当前会话窗口任务计时器与 Tokens 统计逻辑
  // =========================================================================
  let currentTaskData = null;
  let activeTaskState = null;
  let isFetchingTask = false;
  let isTaskPopoverPinned = false;
  let hideTaskPopoverTimer = null;
  const trajectoryCache = new Map(); // trajectoryId -> { turnStepCount, outTokens, cacheTokens, inTokens, activeTool, lastModTime }

  function formatTaskDuration(sec) {
    if (typeof sec !== 'number' || isNaN(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const mm = m < 10 ? '0' + m : '' + m;
    const ss = s < 10 ? '0' + s : '' + s;
    return `${mm}:${ss}`;
  }

  function formatTokens(num) {
    if (typeof num !== 'number' || isNaN(num) || num <= 0) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  // 精准提取当前窗口所属的会话 ID（绝对免疫于焦点移动和非会话标签）
  function resolveCurrentWindowConversationId(trajectoriesList) {
    if (!trajectoriesList || trajectoriesList.length === 0) return null;
    if (trajectoriesList.length === 1) return trajectoriesList[0].id;

    // 1. 最高优先权：直接从 window.location URL 路由解析 /c/<uuid>
    try {
      const path = window.location.pathname || window.location.href || '';
      const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const convId = match[1];
        const found = trajectoriesList.find(t => t.id === convId);
        if (found) return found.id;
      }
    } catch (_) {}

    // 2. 次优先：从当前已激活的会话选项卡 DOM 或输入区属性获取
    try {
      const activeTabEl = document.querySelector('[role="tab"][aria-selected="true"], .tab.active, [data-conversation-id].active');
      let cid = activeTabEl?.getAttribute('data-conversation-id') || activeTabEl?.getAttribute('data-session-id');
      if (cid && trajectoriesList.some(t => t.id === cid)) return cid;

      const inputArea = document.querySelector('[data-conversation-id], [data-session-id]');
      cid = inputArea?.getAttribute('data-conversation-id') || inputArea?.getAttribute('data-session-id');
      if (cid && trajectoriesList.some(t => t.id === cid)) return cid;
    } catch (_) {}

    // 3. 稳态防抖保全：如果先前已有确立的活跃会话，且该会话仍然存在，则坚决保持锁定
    if (activeTaskState?.id && trajectoriesList.some(t => t.id === activeTaskState.id)) {
      return activeTaskState.id;
    }

    return trajectoriesList[0].id;
  }

  // 异步获取具体轨迹的详细 Token 指标与最新工具调用信息
  async function fetchTurnTokenMetrics(trajectoryId, lastModTime) {
    if (!trajectoryId) return null;
    const csrfToken = window.__APP_CONFIG__?.csrfToken;
    if (!csrfToken) return null;

    const cached = trajectoryCache.get(trajectoryId);
    if (cached && cached.lastModTime === lastModTime) {
      return cached;
    }

    try {
      const res = await fetch('/exa.language_server_pb.LanguageServerService/GetTrajectory', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken
        },
        body: JSON.stringify({ trajectoryId })
      });
      if (!res.ok) return null;
      const json = await res.json();
      const trajectory = json.trajectory || json;
      const steps = trajectory?.steps || [];

      let turnStepCount = 0;
      let outTokens = 0;
      let cacheTokens = 0;
      let inTokens = 0;
      let activeTool = null;

      if (steps.length === 0) return null;

      let lastUserIdx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'USER_INPUT') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) return null;

      const currentTurnSteps = steps.slice(lastUserIdx);
      const lastStep = currentTurnSteps[currentTurnSteps.length - 1];
      const isCompleted = lastStep.type === 'PLANNER_RESPONSE' && (!lastStep.tool_calls || lastStep.tool_calls.length === 0);

      turnStepCount = Math.max(0, currentTurnSteps.length - 1);

      for (const st of currentTurnSteps) {
        if (st.output_tokens) outTokens += Number(st.output_tokens) || 0;
        if (st.cache_read_tokens) cacheTokens += Number(st.cache_read_tokens) || 0;
        if (st.input_tokens) inTokens += Number(st.input_tokens) || 0;
      }

      if (!isCompleted && lastStep) {
        if (lastStep.tool_calls && lastStep.tool_calls.length > 0) {
          activeTool = lastStep.tool_calls[0].toolAction || lastStep.tool_calls[0].toolSummary || lastStep.tool_calls[0].name;
        } else if (lastStep.thinking) {
          activeTool = 'Agent 深度思考中';
        }
        if (typeof activeTool === 'string') activeTool = activeTool.replace(/^"|"$/g, '');
      }

      const metrics = {
        turnStepCount,
        outTokens,
        cacheTokens,
        inTokens,
        activeTool,
        lastModTime
      };
      trajectoryCache.set(trajectoryId, metrics);
      return metrics;
    } catch (_) {
      return null;
    }
  }

  // 极速解析活动会话的最新任务状态
  function resolveActiveTaskFast(raw) {
    if (!raw) return null;
    const list = raw.trajectories || (Array.isArray(raw) ? raw : []);
    if (list.length === 0) return null;

    const currentId = resolveCurrentWindowConversationId(list);
    let active = currentId ? list.find(t => t.id === currentId) : null;
    if (!active && activeTaskState?.id) {
      active = list.find(t => t.id === activeTaskState.id);
    }
    if (!active) active = list[0];

    const isRunning = active.status === 'CASCADE_RUN_STATUS_RUNNING';
    const isError = active.status === 'CASCADE_RUN_STATUS_FAILED' || active.status === 'CASCADE_RUN_STATUS_ERROR';

    let userStartTime = null;
    let fallbackStartTime = null;
    if (active.lastModifiedTime) {
      const mod = new Date(active.lastModifiedTime).getTime();
      if (!isNaN(mod)) fallbackStartTime = mod;
    }
    if (active.createdTime) {
      const cr = new Date(active.createdTime).getTime();
      if (!isNaN(cr)) {
        if (!fallbackStartTime) fallbackStartTime = cr;
        userStartTime = cr;
      }
    }
    if (!userStartTime && fallbackStartTime) userStartTime = fallbackStartTime;

    let elapsedSec = 0;
    if (isRunning && userStartTime) {
      elapsedSec = Math.max(0, Math.floor((Date.now() - userStartTime) / 1000));
    } else if (active.metadata?.elapsedDurationSec) {
      elapsedSec = Number(active.metadata.elapsedDurationSec);
    } else if (active.elapsedTime) {
      elapsedSec = Math.floor(Number(active.elapsedTime) / 1000);
    } else if (userStartTime && fallbackStartTime) {
      elapsedSec = Math.max(0, Math.floor((fallbackStartTime - userStartTime) / 1000));
    }

    const cachedMetrics = trajectoryCache.get(active.id);

    return {
      id: active.id,
      title: active.summary || active.title || '当前会话任务',
      status: active.status,
      isRunning,
      isError,
      userStartTime: isRunning ? userStartTime : null,
      lastModTime: active.lastModifiedTime,
      elapsedSec,
      stepCount: cachedMetrics ? cachedMetrics.turnStepCount : (active.stepCount || 0),
      outTokens: cachedMetrics ? cachedMetrics.outTokens : 0,
      cacheTokens: cachedMetrics ? cachedMetrics.cacheTokens : 0,
      inTokens: cachedMetrics ? cachedMetrics.inTokens : 0,
      activeTool: cachedMetrics ? cachedMetrics.activeTool : null
    };
  }

  async function fetchTaskStatus() {
    if (isFetchingTask) return currentTaskData;
    const csrfToken = window.__APP_CONFIG__?.csrfToken;
    if (!csrfToken) return null;

    try {
      isFetchingTask = true;
      const res = await fetch('/exa.language_server_pb.LanguageServerService/ListTrajectories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken
        },
        body: JSON.stringify({ pageSize: 10 })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      currentTaskData = json;
      return json;
    } catch (_) {
      return null;
    } finally {
      isFetchingTask = false;
    }
  }

  function getTaskPopover() {
    let popover = document.getElementById('agy-task-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.id = 'agy-task-popover';
      popover.style.cssText = [
        'position: fixed',
        'display: none',
        'z-index: 999999',
        'width: 320px',
        'background: #18181b',
        'border: 1px solid #27272a',
        'border-radius: 12px',
        'box-shadow: 0 16px 36px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)',
        'padding: 16px',
        'color: #fafafa',
        'font-family: ' + FONT_SANS,
        'font-size: 13px',
        'box-sizing: border-box',
        'opacity: 0',
        'transform: translateY(-4px)',
        'transition: opacity 0.15s ease, transform 0.15s ease',
        'pointer-events: auto'
      ].join(';');

      popover.addEventListener('mouseenter', () => {
        if (hideTaskPopoverTimer) {
          clearTimeout(hideTaskPopoverTimer);
          hideTaskPopoverTimer = null;
        }
      });
      popover.addEventListener('mouseleave', () => {
        const mode = config.triggerMode || 'hover';
        if (mode === 'hover') scheduleHideTaskPopover();
      });

      document.body.appendChild(popover);
    }
    return popover;
  }

  function openTaskPopover(anchorEl, pin = false) {
    if (hideTaskPopoverTimer) {
      clearTimeout(hideTaskPopoverTimer);
      hideTaskPopoverTimer = null;
    }
    if (pin) isTaskPopoverPinned = true;

    const popover = getTaskPopover();
    renderTaskPopoverContent(activeTaskState);

    popover.style.display = 'block';
    const rect = anchorEl.getBoundingClientRect();
    const top = rect.bottom + 8;
    let left = rect.left + (rect.width / 2) - 160;

    const maxLeft = window.innerWidth - 330;
    if (left > maxLeft) left = maxLeft;
    if (left < 10) left = 10;

    popover.style.top = top + 'px';
    popover.style.left = left + 'px';

    requestAnimationFrame(() => {
      popover.style.opacity = '1';
      popover.style.transform = 'translateY(0)';
    });
  }

  function closeTaskPopover(force = false) {
    if (isTaskPopoverPinned && !force) return;
    isTaskPopoverPinned = false;
    const popover = document.getElementById('agy-task-popover');
    if (popover) {
      popover.style.opacity = '0';
      popover.style.transform = 'translateY(-4px)';
      setTimeout(() => {
        if (!isTaskPopoverPinned && popover.style.opacity === '0') {
          popover.style.display = 'none';
        }
      }, 150);
    }
  }

  function scheduleHideTaskPopover() {
    if (isTaskPopoverPinned) return;
    if (hideTaskPopoverTimer) clearTimeout(hideTaskPopoverTimer);
    hideTaskPopoverTimer = setTimeout(() => {
      closeTaskPopover();
    }, 250);
  }

  function renderTaskPopoverContent(task) {
    const popover = getTaskPopover();
    if (!task) {
      popover.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #27272a;padding-bottom:10px;margin-bottom:12px;">
          <div style="font-weight:600;font-size:14px;color:#fafafa;display:flex;align-items:center;gap:6px;">
            <span>⏱️ 任务执行监视</span>
          </div>
          <button id="agy-task-refresh-btn" style="background:transparent;border:none;color:#a1a1aa;cursor:pointer;font-size:13px;padding:2px 4px;">🔄</button>
        </div>
        <div style="text-align:center;padding:24px 0;color:#71717a;font-size:12px;">
          当前会话窗口暂无活动或历史任务
        </div>
      `;
      const refBtn = popover.querySelector('#agy-task-refresh-btn');
      if (refBtn) {
        refBtn.onclick = async (e) => {
          e.stopPropagation();
          refBtn.textContent = '⏳';
          await refreshTaskOnly(true);
        };
      }
      return;
    }

    const timerStr = formatTaskDuration(task.elapsedSec);
    const isRunning = task.isRunning;
    const isError = task.isError;
    const statusText = isRunning ? '正在执行' : (isError ? '执行出错' : '已就绪 / 完成');
    const statusColor = isRunning ? '#22c55e' : (isError ? '#ef4444' : '#94a3b8');

    // 增量更新已存在的 DOM，杜绝频繁展开时的白屏/闪烁
    const timerNumEl = popover.querySelector('#agy-task-popover-timer');
    if (timerNumEl) {
      timerNumEl.textContent = timerStr;
      const statusBadge = popover.querySelector('#agy-task-popover-status-badge');
      if (statusBadge) {
        statusBadge.textContent = statusText;
        statusBadge.style.background = isRunning ? 'rgba(34,197,94,0.18)' : (isError ? 'rgba(239,68,68,0.18)' : 'rgba(148,163,184,0.18)');
        statusBadge.style.color = statusColor;
      }
      const titleEl = popover.querySelector('#agy-task-popover-task-title');
      if (titleEl) titleEl.textContent = task.title;

      const actionText = popover.querySelector('#agy-task-popover-action-text');
      if (actionText) actionText.textContent = task.activeTool || (isRunning ? 'Agent 正在规划下一步动作...' : '本轮对话已顺利交付');

      const stepEl = popover.querySelector('#agy-task-metric-steps');
      if (stepEl) stepEl.textContent = String(task.stepCount || 0);

      const outEl = popover.querySelector('#agy-task-metric-out');
      if (outEl) {
        outEl.textContent = formatTokens(task.outTokens);
        outEl.title = Number(task.outTokens).toLocaleString();
      }

      const cacheEl = popover.querySelector('#agy-task-metric-cache');
      if (cacheEl) {
        cacheEl.textContent = formatTokens(task.cacheTokens);
        cacheEl.title = Number(task.cacheTokens).toLocaleString();
      }

      const inEl = popover.querySelector('#agy-task-metric-in');
      if (inEl) inEl.textContent = formatTokens(task.inTokens);

      return;
    }

    popover.innerHTML = `
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #27272a;padding-bottom:10px;margin-bottom:14px;">
        <div style="font-weight:600;font-size:13px;color:#f4f4f5;display:flex;align-items:center;gap:6px;">
          <span>⏱️ 当前会话耗时监视</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span id="agy-task-popover-status-badge" style="font-size:10px;padding:2px 7px;border-radius:9999px;font-weight:600;font-family:${FONT_SANS};background:${isRunning ? 'rgba(34,197,94,0.18)' : (isError ? 'rgba(239,68,68,0.18)' : 'rgba(148,163,184,0.18)')};color:${statusColor};">
            ${statusText}
          </span>
          <button id="agy-task-refresh-btn" title="强制刷新状态" style="background:transparent;border:none;color:#a1a1aa;cursor:pointer;font-size:12px;padding:2px 4px;line-height:1;">🔄</button>
        </div>
      </div>

      <!-- Main Timer Showcase (Geek Consolas Style) -->
      <div style="text-align:center;padding:12px 10px 14px;background:#09090b;border:1px solid #27272a;border-radius:10px;margin-bottom:12px;">
        <div id="agy-task-popover-timer" style="font-family:${FONT_MONO};font-size:38px;font-weight:800;letter-spacing:1px;color:#22c55e;line-height:1.1;text-shadow:0 0 16px rgba(34,197,94,0.25);">
          ${timerStr}
        </div>
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:6px;">
          <span style="font-size:11px;color:#71717a;font-family:${FONT_SANS};">
            开始于 ${task.userStartTime ? new Date(task.userStartTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '--:--:--'}
          </span>
          <span style="font-size:10px;color:#60a5fa;background:rgba(59,130,246,0.15);padding:1px 6px;border-radius:4px;font-family:${FONT_MONO};">
            指令耗时
          </span>
        </div>
      </div>

      <!-- Task Title & Active Tool -->
      <div style="margin-bottom:12px;background:rgba(255,255,255,0.02);border:1px solid #27272a;border-radius:8px;padding:8px 10px;">
        <div id="agy-task-popover-task-title" style="font-weight:600;font-size:12px;color:#e4e4e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:${FONT_SANS};">
          ${task.title}
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:4px;font-size:11px;color:#a1a1aa;font-family:${FONT_SANS};">
          <span style="color:#eab308;font-size:12px;">⚡</span>
          <span id="agy-task-popover-action-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cbd5e1;font-family:${FONT_MONO};font-size:11px;">
            ${task.activeTool || (isRunning ? 'Agent 正在规划下一步动作...' : '本轮对话已顺利交付')}
          </span>
        </div>
      </div>

      <!-- Turn Token & Cache Metrics Grid -->
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;text-align:center;">
        <div style="background:#09090b;padding:8px 6px;border-radius:8px;border:1px solid #27272a;">
          <div id="agy-task-metric-steps" style="font-family:${FONT_MONO};font-size:15px;font-weight:700;color:#f4f4f5;">
            ${task.stepCount || 0}
          </div>
          <div style="font-size:11px;color:#a1a1aa;margin-top:2px;font-family:${FONT_SANS};">步骤数</div>
        </div>
        <div style="background:#09090b;padding:8px 6px;border-radius:8px;border:1px solid #27272a;">
          <div id="agy-task-metric-out" style="font-family:${FONT_MONO};font-size:15px;font-weight:700;color:#60a5fa;" title="${Number(task.outTokens).toLocaleString()}">
            ${formatTokens(task.outTokens)}
          </div>
          <div style="font-size:11px;color:#a1a1aa;margin-top:2px;font-family:${FONT_SANS};">输出 Tokens</div>
        </div>
        <div style="background:#09090b;padding:8px 6px;border-radius:8px;border:1px solid #27272a;">
          <div id="agy-task-metric-cache" style="font-family:${FONT_MONO};font-size:15px;font-weight:700;color:#22c55e;" title="${Number(task.cacheTokens).toLocaleString()}">
            ${formatTokens(task.cacheTokens)}
          </div>
          <div style="font-size:11px;color:#a1a1aa;margin-top:2px;font-family:${FONT_SANS};">缓存命中</div>
        </div>
      </div>

      <!-- Footer Sub-bar -->
      <div style="font-size:10px;color:#a1a1aa;display:flex;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px solid #27272a;font-family:${FONT_SANS};">
        <span>输入: <strong id="agy-task-metric-in" style="font-family:${FONT_MONO};color:#e4e4e7;">${formatTokens(task.inTokens)}</strong> Tokens</span>
        <span style="color:#22c55e;">● 当前窗口毫秒级同步</span>
      </div>
    `;

    const refBtn = popover.querySelector('#agy-task-refresh-btn');
    if (refBtn) {
      refBtn.onclick = async (e) => {
        e.stopPropagation();
        refBtn.textContent = '⏳';
        await refreshTaskOnly(true);
      };
    }
  }

  function updateTaskTimerPill(task) {
    if (window.__AGY_TASK_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;
    const topBar = document.querySelector('.bg-sidebar') || document.querySelector('.shrink-0');
    if (!topBar) return;

    let pill = document.getElementById('agy-task-timer-topbar');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'agy-task-timer-topbar';
      pill.type = 'button';
      pill.style.cssText = [
        '-webkit-app-region: no-drag !important',
        'app-region: no-drag !important',
        'display: inline-flex',
        'align-items: center',
        'gap: 6px',
        'padding: 3px 10px',
        'border-radius: 9999px',
        'background: var(--card, rgba(255,255,255,0.06))',
        'border: 1px solid var(--border, rgba(255,255,255,0.12))',
        'font-size: 12px',
        'color: var(--foreground, #e5e7eb)',
        'cursor: pointer',
        'margin-left: 6px',
        'user-select: none',
        'outline: none',
        'transition: all 0.15s ease',
        'position: relative',
        'z-index: 50'
      ].join(';');

      pill.innerHTML = `
        <span id="agy-task-pill-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#94a3b8;flex-shrink:0;"></span>
        <span id="agy-task-pill-text" style="font-family:${FONT_MONO};font-size:11px;opacity:0.85;color:#e4e4e7;">就绪</span>
        <span id="agy-task-pill-badge" style="display:none;font-size:10px;color:#60a5fa;background:rgba(59,130,246,0.18);padding:1px 5px;border-radius:3px;max-width:85px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${FONT_MONO};"></span>
      `;

      pill.addEventListener('mouseenter', () => {
        const mode = config.triggerMode || 'hover';
        if (mode === 'hover') openTaskPopover(pill, false);
      });
      pill.addEventListener('mouseleave', () => {
        const mode = config.triggerMode || 'hover';
        if (mode === 'hover') scheduleHideTaskPopover();
      });
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const popover = document.getElementById('agy-task-popover');
        const isCurrentlyVisible = popover && popover.style.display === 'block' && popover.style.opacity === '1';
        if (isCurrentlyVisible && isTaskPopoverPinned) {
          closeTaskPopover();
        } else {
          openTaskPopover(pill, true);
          refreshTaskOnly(true);
        }
      });

      // 如果有配额胶囊，放置在配额胶囊之后；否则直接挂在顶栏
      const quotaPill = document.getElementById('agy-model-quota-topbar');
      if (quotaPill && quotaPill.nextSibling) {
        topBar.insertBefore(pill, quotaPill.nextSibling);
      } else {
        topBar.appendChild(pill);
      }
    }

    const dotEl = pill.querySelector('#agy-task-pill-dot');
    const textEl = pill.querySelector('#agy-task-pill-text');
    const badgeEl = pill.querySelector('#agy-task-pill-badge');

    if (!task) {
      if (dotEl) {
        dotEl.style.background = '#94a3b8';
        dotEl.style.boxShadow = 'none';
        dotEl.style.animation = 'none';
      }
      if (textEl) textEl.textContent = '任务就绪';
      if (badgeEl) badgeEl.style.display = 'none';
      pill.title = '当前会话暂无任务\n单击展开详情与 Token 统计';
      return;
    }

    const timeFormatted = formatTaskDuration(task.elapsedSec);

    if (task.isRunning) {
      if (dotEl) {
        dotEl.style.background = '#22c55e';
        if (!dotEl.style.animation || dotEl.style.animation === 'none') {
          dotEl.style.animation = 'agy-task-pulse-dot 1.8s infinite ease-in-out';
        }
      }
      if (textEl) {
        textEl.textContent = `执行中 ${timeFormatted}`;
      }
      if (badgeEl) {
        if (task.activeTool) {
          badgeEl.textContent = task.activeTool;
          badgeEl.style.display = 'inline-block';
        } else {
          badgeEl.style.display = 'none';
        }
      }
      pill.title = `任务正在执行: ${timeFormatted}\n当前步骤: ${task.activeTool || '思考中'}\n单击展开详情与 Token 统计`;
    } else if (task.isError) {
      if (dotEl) {
        dotEl.style.background = '#ef4444';
        dotEl.style.boxShadow = 'none';
        dotEl.style.animation = 'none';
      }
      if (textEl) textEl.textContent = `失败 ${timeFormatted}`;
      if (badgeEl) badgeEl.style.display = 'none';
      pill.title = `任务执行失败 (耗时: ${timeFormatted})\n单击查看详情`;
    } else {
      if (dotEl) {
        dotEl.style.background = '#94a3b8';
        dotEl.style.boxShadow = 'none';
        dotEl.style.animation = 'none';
      }
      if (textEl) {
        textEl.textContent = task.elapsedSec > 0 ? `已完成 ${timeFormatted}` : '就绪';
      }
      if (badgeEl) badgeEl.style.display = 'none';
      pill.title = `当前会话任务就绪 (上次耗时: ${timeFormatted})\n单击展开详情与 Token 统计`;
    }
  }

  // 本地每秒平滑秒表递增
  function tickTimer() {
    if (window.__AGY_TASK_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;
    if (activeTaskState && activeTaskState.isRunning && activeTaskState.userStartTime) {
      const elapsed = Math.max(0, Math.floor((Date.now() - activeTaskState.userStartTime) / 1000));
      activeTaskState.elapsedSec = elapsed;

      updateTaskTimerPill(activeTaskState);

      const popoverTimerEl = document.getElementById('agy-task-popover-timer');
      if (popoverTimerEl) {
        popoverTimerEl.textContent = formatTaskDuration(elapsed);
      }
    }
  }

  async function refreshTaskOnly(force = false) {
    if (window.__AGY_TASK_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;
    const raw = await fetchTaskStatus();
    if (!raw || window.__AGY_TASK_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;

    // 1. 0ms 同步极速通道：提取当前会话并毫秒级更新顶栏胶囊与标题
    activeTaskState = resolveActiveTaskFast(raw);
    updateTaskTimerPill(activeTaskState);
    renderTaskPopoverContent(activeTaskState);

    // 2. 异步慢通道：在后台非阻塞解析本轮 Token 与工具调用
    if (activeTaskState?.id) {
      const activeId = activeTaskState.id;
      const lastMod = activeTaskState.lastModTime;
      fetchTurnTokenMetrics(activeId, lastMod).then(tokenMetrics => {
        if (tokenMetrics && activeTaskState && activeTaskState.id === activeId) {
          activeTaskState.stepCount = tokenMetrics.turnStepCount;
          activeTaskState.outTokens = tokenMetrics.outTokens;
          activeTaskState.cacheTokens = tokenMetrics.cacheTokens;
          activeTaskState.inTokens = tokenMetrics.inTokens;
          activeTaskState.activeTool = tokenMetrics.activeTool;
          updateTaskTimerPill(activeTaskState);
          renderTaskPopoverContent(activeTaskState);
        }
      });
    }
  }

  function setupPollingTimer() {
    if (window.__AGY_TASK_POLL_TIMER__) {
      clearInterval(window.__AGY_TASK_POLL_TIMER__);
      window.__AGY_TASK_POLL_TIMER__ = null;
    }
    // 1 秒一次同步当前窗口会话与任务变动
    window.__AGY_TASK_POLL_TIMER__ = setInterval(() => {
      refreshTaskOnly(false);
    }, 1000);
  }

  // 点击外部收起
  function onDocumentClick(e) {
    const taskPill = document.getElementById('agy-task-timer-topbar');
    const taskPopover = document.getElementById('agy-task-popover');
    if (!(taskPill && taskPill.contains(e.target)) && !(taskPopover && taskPopover.contains(e.target))) {
      closeTaskPopover();
    }
  }
  document.addEventListener('click', onDocumentClick, true);

  let debounceAttachTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceAttachTimer) clearTimeout(debounceAttachTimer);
    debounceAttachTimer = setTimeout(() => {
      const taskPill = document.getElementById('agy-task-timer-topbar');
      if (!taskPill) {
        if (!activeTaskState && currentTaskData) {
          activeTaskState = resolveActiveTaskFast(currentTaskData);
        }
        updateTaskTimerPill(activeTaskState);
      }
    }, 150);
  });

  // 安全启动
  function startObserverAndMount() {
    const root = document.body || document.documentElement;
    if (root) {
      try {
        observer.observe(root, { childList: true, subtree: true });
      } catch (_) {}
    }
    refreshTaskOnly(true);
    setupPollingTimer();

    // 启动 1 秒本地平滑秒表
    if (window.__AGY_TASK_TICK_TIMER__) {
      clearInterval(window.__AGY_TASK_TICK_TIMER__);
    }
    window.__AGY_TASK_TICK_TIMER__ = setInterval(tickTimer, 1000);

    let retryCount = 0;
    const retryTimer = setInterval(() => {
      retryCount++;
      const taskPill = document.getElementById('agy-task-timer-topbar');
      if (!taskPill) {
        updateTaskTimerPill(activeTaskState);
      }
      if (taskPill || retryCount >= 10) {
        clearInterval(retryTimer);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserverAndMount);
  } else {
    startObserverAndMount();
  }

  const onWindowActivate = () => {
    tickTimer();
    refreshTaskOnly(true);
  };
  window.addEventListener('focus', onWindowActivate);

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      onWindowActivate();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // 毫秒级捕获会话标签与侧边栏点击，彻底消除切换会话的等待延迟
  const onPointerUp = (e) => {
    const target = e.target;
    if (target && target.closest && (target.closest('.tabs-container') || target.closest('.monaco-list') || target.closest('[role="tab"]') || target.closest('.activitybar'))) {
      setTimeout(() => refreshTaskOnly(false), 50);
    }
  };
  document.addEventListener('pointerup', onPointerUp, true);

  window.__AGY_TASK_TIMER_CLEANUP__ = () => {
    observer.disconnect();
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (window.__AGY_TASK_POLL_TIMER__) {
      clearInterval(window.__AGY_TASK_POLL_TIMER__);
      window.__AGY_TASK_POLL_TIMER__ = null;
    }
    if (window.__AGY_TASK_TICK_TIMER__) {
      clearInterval(window.__AGY_TASK_TICK_TIMER__);
      window.__AGY_TASK_TICK_TIMER__ = null;
    }
    window.removeEventListener('focus', onWindowActivate);
    removeEl('agy-task-timer-topbar');
    removeEl('agy-task-popover');
  };
})();

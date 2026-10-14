/**
 * Antigravity Real-Time Session Task Execution Timer & Metrics Indicator
 * Google 反重力桌面客户端任务耗时胶囊、Tokens 统计与缓存命中监控插件
 *
 * 核心特性：
 * 1. 顶栏微型任务胶囊：显示执行状态与动态秒表 (● 任务: 01:23)
 * 2. 视觉排版与字体风格：像素级对齐余额胶囊（12px 标准字号、水平垂直居中、Consolas 优雅等宽数字）
 * 3. 悬浮窗详情展示：Consolas 极客风大号秒表、2x2 指标卡片（输出 Tokens、缓存命中 Cache、输入 Tokens、轮次步骤）
 * 4. 0 占用主编辑区与会话区水平宽度，支持悬停预览与单击展开锁定
 * 5. 严格轮次生命周期隔离：同窗口新任务自动从 00:00 重新计时，绝不累加上次任务耗时
 * 6. 极速尾部倒序解析器：3ms 极速提取本轮 Tokens 与工具调用，彻底消除主线程卡顿
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

  // 唯一实例 ID 守卫：使旧实例在下一次循环时自动静默退出，彻底根除多版本争抢 DOM
  const WIDGET_INSTANCE_ID = 'agy_task_inst_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  window.__AGY_ACTIVE_INSTANCE_ID__ = WIDGET_INSTANCE_ID;

  if (window.__AGY_TASK_TICK_TIMER__) {
    clearInterval(window.__AGY_TASK_TICK_TIMER__);
    window.__AGY_TASK_TICK_TIMER__ = null;
  }
  if (window.__AGY_TASK_POLL_TIMER__) {
    clearInterval(window.__AGY_TASK_POLL_TIMER__);
    window.__AGY_TASK_POLL_TIMER__ = null;
  }

  window.__AGY_TASK_TIMER_INITIALIZED__ = true;

  // 字体栈（对齐 Antigravity 原生与 Windows 经典 Consolas）
  const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const FONT_MONO = 'Consolas, ui-monospace, SFMono-Regular, Menlo, monospace';

  // 注入微型柔和呼吸动效样式
  if (typeof document !== 'undefined' && !document.getElementById('agy-pulse-style')) {
    const s = document.createElement('style');
    s.id = 'agy-pulse-style';
    s.textContent = `
      @keyframes agy-pulse-dot {
        0%, 100% { opacity: 0.85; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.15); box-shadow: 0 0 7px rgba(34,197,94,0.9); }
      }
    `;
    document.head.appendChild(s);
  }

  // 用户持久化配置
  const CONFIG_STORAGE_KEY = 'agy_quota_widget_config_v2';
  const DEFAULT_CONFIG = {
    triggerMode: 'hover',
    taskTriggerMode: 'hover'
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
  // 任务状态与指标数据逻辑
  // =========================================================================
  let currentTaskData = null;
  let isFetchingTask = false;
  let isFetchingTokenMetrics = false;
  let lastTokenFetchTime = 0;
  let isTaskPopoverPinned = false;
  let hideTaskPopoverTimer = null;
  let activeTaskState = null;

  function formatTaskDuration(sec) {
    if (sec < 0 || isNaN(sec)) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const remM = m % 60;
      return `${pad(h)}:${pad(remM)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  }

  function formatTokens(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return Number(n).toLocaleString('en-US');
  }

  // 获取当前窗口对应的会话 ID (仅当且仅当路由在当前会话 /c/:id 时提取，排除 /、/c/new 等非会话状态)
  function getCurrentWindowConvId() {
    try {
      const path = window.location.pathname || window.location.href || '';
      const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (match && match[1] && match[1] !== 'new') return match[1];
    } catch (_) {}
    return null;
  }

  // 提取 Trajectories 数组（适配 trajectories 数组与 trajectorySummaries 字典）
  function extractTrajectoriesList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw.trajectories)) {
      return raw.trajectories;
    }
    if (raw.trajectorySummaries && typeof raw.trajectorySummaries === 'object') {
      return Object.entries(raw.trajectorySummaries).map(([id, sum]) => ({
        id,
        ...sum
      }));
    }
    return [];
  }

  // 轮次唯一标识生成器：由会话ID + 用户输入步骤索引（或输入时间戳）构成
  function getTurnKey(active) {
    if (!active) return '';
    const inputKey = active.lastUserInputStepIndex ?? active.lastUserInputTime ?? active.createdTime ?? '';
    return `${active.id}_${inputKey}`;
  }

  // 获取所有会话概览 RPC
  async function fetchTaskStatus() {
    if (isFetchingTask) return currentTaskData;
    const csrfToken = window.__APP_CONFIG__?.csrfToken;
    if (!csrfToken) return null;

    try {
      isFetchingTask = true;
      const res = await fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken
        },
        body: JSON.stringify({})
      });
      if (!res.ok) return null;
      const json = await res.json();
      currentTaskData = json;
      return json;
    } catch (_) {
      return null;
    } finally {
      isFetchingTask = false;
    }
  }

  // 本轮 Token 统计缓存 (convId -> { lastModTime, data })
  const tokenMetricsCache = new Map();

  // 高性能 Base64 解码器 (优先 Node Buffer 2ms，回退快速数组循环 9ms，坚决不用 arrow closure)
  function decodeBase64ToUtf8(b64) {
    if (typeof Buffer !== 'undefined') {
      try { return Buffer.from(b64, 'base64').toString('utf-8'); } catch (_) {}
    }
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  // 读取指定会话 transcript.jsonl 并仅解析当前轮次（从尾部倒序查找，3ms 极速解析，彻底消灭 UI 卡死）
  async function fetchTurnTokenMetrics(convId, lastModTime = 0) {
    if (!convId || isFetchingTokenMetrics) return null;
    const cacheKey = convId;
    if (lastModTime && tokenMetricsCache.has(cacheKey)) {
      const cached = tokenMetricsCache.get(cacheKey);
      if (cached.lastModTime === lastModTime) {
        return cached.data;
      }
    }
    const csrfToken = window.__APP_CONFIG__?.csrfToken;
    if (!csrfToken) return null;

    try {
      isFetchingTokenMetrics = true;
      lastTokenFetchTime = Date.now();

      const uri = `file:///C:/Users/HXY/.gemini/antigravity/brain/${convId}/.system_generated/logs/transcript.jsonl`;
      const res = await fetch('/exa.language_server_pb.LanguageServerService/ReadFile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken
        },
        body: JSON.stringify({ uri })
      });
      if (!res.ok) return null;
      const fileData = await res.json();
      if (!fileData?.content) return null;

      // 1. 极速解码
      const text = decodeBase64ToUtf8(fileData.content);

      // 2. 从尾部倒序快速定位最后一个 USER_INPUT，仅截取本轮数据
      const marker = '"type":"USER_INPUT"';
      let userIdx = text.lastIndexOf(marker);
      if (userIdx === -1) userIdx = text.lastIndexOf('"type": "USER_INPUT"');

      let turnText = text;
      if (userIdx !== -1) {
        const lineStart = text.lastIndexOf('\n', userIdx);
        turnText = lineStart !== -1 ? text.slice(lineStart + 1) : text.slice(userIdx);
      }

      // 3. 仅解析本轮的 10~30 行，而非全文 1500+ 行
      const turnLines = turnText.trim().split('\n').filter(Boolean);
      const steps = [];
      for (const l of turnLines) {
        try { steps.push(JSON.parse(l)); } catch (_) {}
      }
      if (steps.length === 0) return null;

      let lastUserIdx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'USER_INPUT') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) return null;

      const turnSteps = steps.slice(lastUserIdx);
      const userStep = turnSteps[0];
      const lastStep = turnSteps[turnSteps.length - 1];
      const isCompleted = lastStep.type === 'PLANNER_RESPONSE' && (!lastStep.tool_calls || lastStep.tool_calls.length === 0);

      let outTokens = 0;
      let cacheTokens = 0;
      let inTokens = 0;
      let activeTool = null;
      const turnStepCount = Math.max(0, turnSteps.length - 1);

      for (const st of turnSteps) {
        if (st.output_tokens) outTokens += Number(st.output_tokens) || 0;
        if (st.cache_read_tokens) cacheTokens += Number(st.cache_read_tokens) || 0;
        if (st.input_tokens) inTokens += Number(st.input_tokens) || 0;
      }

      if (!isCompleted && lastStep) {
        if (lastStep.tool_calls && lastStep.tool_calls.length > 0) {
          activeTool = lastStep.tool_calls[0].toolAction || lastStep.tool_calls[0].toolSummary || lastStep.tool_calls[0].name;
        } else if (lastStep.thinking) {
          activeTool = 'Agent 思考规划中';
        }
        if (typeof activeTool === 'string') activeTool = activeTool.replace(/^"|"$/g, '');
      }

      const startTime = userStep.created_at ? new Date(userStep.created_at).getTime() : Date.now();
      const endTime = isCompleted && lastStep.created_at ? new Date(lastStep.created_at).getTime() : Date.now();
      const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));

      const data = {
        turnStepCount,
        outTokens,
        cacheTokens,
        inTokens,
        activeTool,
        isCompleted,
        startTime,
        elapsedSec
      };

      tokenMetricsCache.set(cacheKey, { lastModTime, data });
      return data;
    } catch (_) {
      return null;
    } finally {
      isFetchingTokenMetrics = false;
    }
  }

  // 极速解析活动会话（含严格的同窗口多轮次生命周期隔离与新会话防御）
  function resolveActiveTaskFast(raw) {
    const trajectories = extractTrajectoriesList(raw);
    const currentId = getCurrentWindowConvId();

    // 核心隔离 1：当前窗口若处于“新建会话”（URL 没有 /c/:id 或为 /c/new），绝不能抢占其它窗口的任务！
    if (!currentId) {
      activeTaskState = {
        id: null,
        turnKey: 'empty_new_session',
        title: '新会话',
        isRunning: false,
        isError: false,
        userStartTime: null,
        lastModTime: 0,
        lastStepCount: 0,
        turnStepIndex: 0,
        elapsedSec: 0,
        stepCount: 0,
        outTokens: 0,
        cacheTokens: 0,
        inTokens: 0,
        activeTool: null
      };
      return activeTaskState;
    }

    // 核心隔离 2：严格绑定当前窗口匹配的会话，若该会话尚无服务端 Trajectory 则置为空闲初始态，绝不抢占其它任务
    const active = trajectories.find(t => t.id === currentId);
    if (!active) {
      activeTaskState = {
        id: currentId,
        turnKey: `${currentId}_initial`,
        title: '当前会话任务',
        isRunning: false,
        isError: false,
        userStartTime: null,
        lastModTime: 0,
        lastStepCount: 0,
        turnStepIndex: 0,
        elapsedSec: 0,
        stepCount: 0,
        outTokens: 0,
        cacheTokens: 0,
        inTokens: 0,
        activeTool: null
      };
      return activeTaskState;
    }

    const turnKey = getTurnKey(active);
    const isRpcRunning = active.status === 'CASCADE_RUN_STATUS_RUNNING';
    const isError = active.status === 'CASCADE_RUN_STATUS_FAILED' || active.status === 'CASCADE_RUN_STATUS_ERROR';

    // 核心生命周期判断：检测是否为新任务、新轮次、或状态由空闲转为执行中
    const isConvChanged = !activeTaskState || activeTaskState.id !== active.id;
    const isTurnChanged = Boolean(activeTaskState?.turnKey && turnKey && activeTaskState.turnKey !== turnKey);
    const isIdleToRunning = Boolean(activeTaskState && !activeTaskState.isRunning && isRpcRunning);
    const isNewTaskOrTurn = isConvChanged || isTurnChanged || isIdleToRunning;

    if (isNewTaskOrTurn) {
      tokenMetricsCache.delete(active.id);

      let userStartTime = null;
      if (active.lastUserInputTime) {
        const t = new Date(active.lastUserInputTime).getTime();
        if (!isNaN(t) && t <= Date.now()) userStartTime = t;
      }
      if (!userStartTime && isRpcRunning) {
        userStartTime = Date.now();
      }

      let elapsedSec = 0;
      if (isRpcRunning && userStartTime) {
        elapsedSec = Math.max(0, Math.floor((Date.now() - userStartTime) / 1000));
      } else if (!isRpcRunning && userStartTime && active.lastModifiedTime) {
        const endT = new Date(active.lastModifiedTime).getTime();
        if (!isNaN(endT) && endT >= userStartTime) {
          elapsedSec = Math.max(0, Math.floor((endT - userStartTime) / 1000));
        }
      }

      const turnStepCount = Math.max(0, (active.stepCount || 0) - (active.lastUserInputStepIndex || 0));

      activeTaskState = {
        id: active.id,
        turnKey,
        title: active.annotations?.title || active.summary || '当前会话任务',
        isRunning: isRpcRunning,
        isError,
        userStartTime,
        lastModTime: active.lastModifiedTime ? new Date(active.lastModifiedTime).getTime() : 0,
        lastStepCount: active.stepCount || 0,
        turnStepIndex: active.lastUserInputStepIndex,
        elapsedSec,
        stepCount: turnStepCount,
        outTokens: 0,
        cacheTokens: 0,
        inTokens: 0,
        activeTool: isRpcRunning ? 'Agent 规划中...' : null
      };

      return activeTaskState;
    }

    // 同一轮任务平滑推进（秒数只增不减，但决不越轮次累加）
    activeTaskState.isRunning = isRpcRunning;
    activeTaskState.isError = isError;
    activeTaskState.title = active.annotations?.title || active.summary || activeTaskState.title;
    activeTaskState.lastModTime = active.lastModifiedTime ? new Date(active.lastModifiedTime).getTime() : activeTaskState.lastModTime;
    activeTaskState.lastStepCount = active.stepCount || activeTaskState.lastStepCount;
    activeTaskState.stepCount = Math.max(0, (active.stepCount || 0) - (active.lastUserInputStepIndex || 0));

    if (activeTaskState.isRunning && activeTaskState.userStartTime) {
      const calculated = Math.max(0, Math.floor((Date.now() - activeTaskState.userStartTime) / 1000));
      activeTaskState.elapsedSec = Math.max(activeTaskState.elapsedSec || 0, calculated);
    }

    return activeTaskState;
  }

  // =========================================================================
  // 悬浮详情卡片 (Popover) - 像素级匹配图二极客质感
  // =========================================================================
  function getOrCreateTaskPopover() {
    let popover = document.getElementById('agy-task-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.id = 'agy-task-popover';
      popover.style.cssText = [
        '-webkit-app-region: no-drag !important',
        'app-region: no-drag !important',
        'position: fixed',
        'z-index: 999999',
        'width: 330px',
        'background: #121316',
        'border: 1px solid #27272a',
        'border-radius: 10px',
        'box-shadow: 0 20px 48px rgba(0,0,0,0.65), 0 4px 16px rgba(0,0,0,0.3)',
        'padding: 12px',
        'font-size: 13px',
        'color: #e4e4e7',
        'backdrop-filter: blur(14px)',
        '-webkit-backdrop-filter: blur(14px)',
        'display: none',
        'opacity: 0',
        'transform: translateY(-6px)',
        'transition: opacity 0.18s ease, transform 0.18s ease',
        'pointer-events: auto',
        'font-family: ' + FONT_SANS
      ].join(';');

      popover.addEventListener('mouseenter', () => {
        if (hideTaskPopoverTimer) clearTimeout(hideTaskPopoverTimer);
      });
      popover.addEventListener('mouseleave', () => {
        if (isTaskPopoverPinned) return;
        const mode = config.taskTriggerMode || 'hover';
        if (mode === 'hover') scheduleHideTaskPopover();
      });
      popover.addEventListener('click', (e) => e.stopPropagation());
      document.body.appendChild(popover);
    }
    return popover;
  }

  function openTaskPopover(targetElement, pin = false) {
    if (hideTaskPopoverTimer) {
      clearTimeout(hideTaskPopoverTimer);
      hideTaskPopoverTimer = null;
    }
    if (pin) isTaskPopoverPinned = true;

    // 优雅关闭可能开启的余额面板
    try {
      const qPop = document.getElementById('agy-quota-popover');
      if (qPop) {
        qPop.style.opacity = '0';
        qPop.style.display = 'none';
      }
    } catch (_) {}

    const popover = getOrCreateTaskPopover();
    renderTaskPopoverContent(activeTaskState);

    const rect = targetElement.getBoundingClientRect();
    popover.style.display = 'block';

    let left = rect.left + (rect.width / 2) - 165;
    const maxLeft = window.innerWidth - 345;
    if (left > maxLeft) left = maxLeft;
    if (left < 10) left = 10;

    const top = rect.bottom + 6;
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';

    void popover.offsetHeight; // 强制同步重排，立即触发平滑渐变
    popover.style.opacity = '1';
    popover.style.transform = 'translateY(0)';
  }

  function closeTaskPopover(force = false) {
    if (isTaskPopoverPinned && !force) return;
    if (force) isTaskPopoverPinned = false;
    if (hideTaskPopoverTimer) {
      clearTimeout(hideTaskPopoverTimer);
      hideTaskPopoverTimer = null;
    }
    const popover = document.getElementById('agy-task-popover');
    if (!popover) return;

    popover.style.opacity = '0';
    popover.style.transform = 'translateY(-6px)';
    setTimeout(() => {
      if (!isTaskPopoverPinned) {
        popover.style.display = 'none';
      }
    }, 180);
  }

  function scheduleHideTaskPopover() {
    if (isTaskPopoverPinned) return;
    if (hideTaskPopoverTimer) clearTimeout(hideTaskPopoverTimer);
    hideTaskPopoverTimer = setTimeout(() => {
      if (!isTaskPopoverPinned) closeTaskPopover(false);
    }, 220);
  }

  function renderTaskPopoverContent(task) {
    const popover = getOrCreateTaskPopover();

    const titleText = !task?.id ? '新会话 (就绪)' : (task?.title || '当前会话任务');
    const isRunning = Boolean(task?.isRunning);
    const isError = Boolean(task?.isError);
    const elapsedSec = task?.elapsedSec || 0;
    const timerStr = formatTaskDuration(elapsedSec);
    const timerColor = isRunning ? '#22c55e' : (isError ? '#ef4444' : '#94a3b8');
    const timerGlow = isRunning ? 'rgba(34,197,94,0.25)' : 'none';

    let timerLabelText = '任务状态: 就绪';
    if (isRunning) {
      timerLabelText = '当前轮次已执行';
    } else if (isError) {
      timerLabelText = '任务执行失败';
    } else if (elapsedSec > 0) {
      timerLabelText = '上次轮次耗时';
    }

    const startTimeFormatted = task?.userStartTime
      ? new Date(task.userStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '--:--:--';

    // 增量 DOM 更新，避免白屏与闪烁
    const timerNumEl = popover.querySelector('#agy-task-popover-timer');
    if (timerNumEl) {
      const timerLabelEl = popover.querySelector('#agy-task-popover-timer-label');
      if (timerLabelEl && timerLabelEl.textContent !== timerLabelText) {
        timerLabelEl.textContent = timerLabelText;
      }

      if (timerNumEl.textContent !== timerStr) {
        timerNumEl.textContent = timerStr;
      }
      timerNumEl.style.color = timerColor;
      timerNumEl.style.textShadow = timerGlow !== 'none' ? `0 0 16px ${timerGlow}` : 'none';

      const titleEl = popover.querySelector('#agy-task-popover-task-title');
      const fullTitle = '📌 ' + titleText;
      if (titleEl && titleEl.textContent !== fullTitle) {
        titleEl.textContent = fullTitle;
      }

      const outEl = popover.querySelector('#agy-task-metric-out');
      if (outEl) {
        const outStr = formatTokens(task?.outTokens);
        if (outEl.textContent !== outStr) outEl.textContent = outStr;
        outEl.title = Number(task?.outTokens || 0).toLocaleString();
      }

      const cacheEl = popover.querySelector('#agy-task-metric-cache');
      if (cacheEl) {
        const cacheStr = formatTokens(task?.cacheTokens);
        if (cacheEl.textContent !== cacheStr) cacheEl.textContent = cacheStr;
        cacheEl.title = Number(task?.cacheTokens || 0).toLocaleString();
      }

      const inEl = popover.querySelector('#agy-task-metric-in');
      if (inEl) {
        const inStr = formatTokens(task?.inTokens);
        if (inEl.textContent !== inStr) inEl.textContent = inStr;
        inEl.title = Number(task?.inTokens || 0).toLocaleString();
      }

      const stepEl = popover.querySelector('#agy-task-metric-steps');
      if (stepEl) {
        const stepStr = (task?.stepCount || 0) + ' 步';
        if (stepEl.textContent !== stepStr) stepEl.textContent = stepStr;
      }

      const actionBox = popover.querySelector('#agy-task-popover-action-box');
      const actionText = popover.querySelector('#agy-task-popover-action-text');
      if (actionBox && actionText) {
        if (task?.activeTool) {
          actionBox.style.display = 'flex';
          if (actionText.textContent !== task.activeTool) {
            actionText.textContent = task.activeTool;
          }
        } else {
          actionBox.style.display = 'none';
        }
      }

      const startEl = popover.querySelector('#agy-task-popover-start-time');
      const startStr = '起始: ' + startTimeFormatted;
      if (startEl && startEl.textContent !== startStr) {
        startEl.textContent = startStr;
      }

      return;
    }

    // 初次构建弹窗 HTML（完全对齐图二布局）
    popover.innerHTML = `
      <!-- 大号秒表与会话标题卡片 -->
      <div style="background:#16171a;border:1px solid #27272a;border-radius:8px;padding:12px 10px;text-align:center;">
        <div id="agy-task-popover-timer-label" style="font-size:12px;color:#a1a1aa;margin-bottom:6px;">${timerLabelText}</div>
        <div id="agy-task-popover-timer" style="font-family:${FONT_MONO};font-size:38px;font-weight:700;color:${timerColor};letter-spacing:1px;line-height:1;text-shadow:${timerGlow !== 'none' ? `0 0 16px ${timerGlow}` : 'none'};">
          ${timerStr}
        </div>
        <div id="agy-task-popover-task-title" style="margin-top:8px;font-size:12px;font-weight:500;color:#e4e4e7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          📌 ${titleText}
        </div>
      </div>

      <!-- 2x2 指标网格（完全匹配图二） -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
        <div style="background:#1c1d22;border:1px solid #27272a;border-radius:7px;padding:9px 6px;text-align:center;">
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:3px;">输出 Tokens</div>
          <div id="agy-task-metric-out" style="font-family:${FONT_MONO};font-size:17px;font-weight:700;color:#60a5fa;" title="${Number(task?.outTokens || 0).toLocaleString()}">
            ${formatTokens(task?.outTokens)}
          </div>
        </div>

        <div style="background:#1c1d22;border:1px solid #27272a;border-radius:7px;padding:9px 6px;text-align:center;">
          <div style="font-size:11px;color:#34d399;margin-bottom:3px;">缓存命中 (Cache)</div>
          <div id="agy-task-metric-cache" style="font-family:${FONT_MONO};font-size:17px;font-weight:700;color:#34d399;" title="${Number(task?.cacheTokens || 0).toLocaleString()}">
            ${formatTokens(task?.cacheTokens)}
          </div>
        </div>

        <div style="background:#1c1d22;border:1px solid #27272a;border-radius:7px;padding:9px 6px;text-align:center;">
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:3px;">输入 Tokens</div>
          <div id="agy-task-metric-in" style="font-family:${FONT_MONO};font-size:17px;font-weight:700;color:#f4f4f5;" title="${Number(task?.inTokens || 0).toLocaleString()}">
            ${formatTokens(task?.inTokens)}
          </div>
        </div>

        <div style="background:#1c1d22;border:1px solid #27272a;border-radius:7px;padding:9px 6px;text-align:center;">
          <div style="font-size:11px;color:#a1a1aa;margin-bottom:3px;">轮次步骤</div>
          <div id="agy-task-metric-steps" style="font-family:${FONT_MONO};font-size:17px;font-weight:700;color:#f4f4f5;">
            ${task?.stepCount || 0} 步
          </div>
        </div>
      </div>

      <!-- 活动工具提示条 (执行中出现) -->
      <div id="agy-task-popover-action-box" style="display:${task?.activeTool ? 'flex' : 'none'};margin-top:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.22);border-radius:6px;padding:6px 10px;align-items:center;gap:6px;font-size:11px;">
        <span style="color:#eab308;font-size:12px;">⚡</span>
        <span id="agy-task-popover-action-text" style="color:#93c5fd;font-family:${FONT_MONO};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${task?.activeTool || ''}
        </span>
      </div>

      <!-- 底部辅助信息条 -->
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #27272a;display:flex;justify-content:space-between;font-size:11px;color:#71717a;font-family:${FONT_SANS};">
        <span id="agy-task-popover-start-time">起始: ${startTimeFormatted}</span>
        <span style="color:#22c55e;">● 当前窗口自动感应</span>
      </div>
    `;
  }

  // =========================================================================
  // 顶栏微型计时胶囊 (Top Bar Pill) - 像素级对齐余额胶囊（12px 标准字号、水平居中）
  // =========================================================================
  function updateTaskTimerPill(task) {
    if (window.__AGY_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;
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
        'justify-content: center',
        'text-align: center',
        'gap: 6px',
        'padding: 3px 10px',
        'min-height: 25px',
        'box-sizing: border-box',
        'border-radius: 9999px',
        'background: var(--card, rgba(255,255,255,0.06))',
        'border: 1px solid var(--border, rgba(255,255,255,0.12))',
        'font-size: 12px',
        'line-height: 18px',
        'color: var(--foreground, #e5e7eb)',
        'cursor: pointer',
        'margin-left: 8px',
        'user-select: none',
        'outline: none',
        'transition: all 0.15s ease',
        'position: relative',
        'z-index: 50',
        'font-family: ' + FONT_SANS
      ].join(';');

      pill.addEventListener('mouseenter', () => {
        const mode = config.taskTriggerMode || 'hover';
        if (mode === 'hover') openTaskPopover(pill, false);
      });
      pill.addEventListener('mouseleave', () => {
        const mode = config.taskTriggerMode || 'hover';
        if (mode === 'hover') scheduleHideTaskPopover();
      });

      // 单击展开 / 收起切换
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const popover = document.getElementById('agy-task-popover');
        const isVisible = popover && popover.style.display !== 'none' && popover.style.opacity === '1';

        if (isVisible && isTaskPopoverPinned) {
          closeTaskPopover(true);
        } else {
          openTaskPopover(pill, true);
          refreshTaskOnly(true);
        }
      });

      pill.addEventListener('mousedown', () => {
        pill.style.transform = 'scale(0.96)';
      });
      pill.addEventListener('mouseup', () => {
        pill.style.transform = 'scale(1)';
      });

    }

    // 无论是否初次创建，均持续确保任务胶囊严格位于 Gemini 余额胶囊右侧！
    const quotaPill = document.getElementById('agy-model-quota-topbar');
    if (quotaPill && quotaPill.parentNode === topBar) {
      if (pill.previousElementSibling !== quotaPill) {
        quotaPill.after(pill);
      }
    } else if (pill.parentNode !== topBar) {
      topBar.appendChild(pill);
    }

    let dotEl = document.getElementById('agy-task-pill-dot');
    let labelEl = document.getElementById('agy-task-pill-label');
    let timeEl = document.getElementById('agy-task-pill-time');
    let spacerEl = document.getElementById('agy-task-pill-spacer');

    const isRunning = Boolean(task?.isRunning);
    const isError = Boolean(task?.isError);
    const hasElapsed = Boolean(task?.elapsedSec);
    const timeFormatted = formatTaskDuration(task?.elapsedSec || 0);

    let dotColor = '#94a3b8';
    let isPulse = false;
    let labelText = '任务';
    let timeText = '就绪';
    let labelColor = 'var(--foreground, #e5e7eb)';
    let timeColor = '#94a3b8';
    let pillBg = 'var(--card, rgba(255,255,255,0.06))';
    let pillBorder = 'var(--border, rgba(255,255,255,0.12))';
    let pillTitle = '当前会话任务就绪\n单击展开详情与 Token 统计';

    if (isRunning) {
      dotColor = '#22c55e';
      isPulse = true;
      labelText = '执行中';
      timeText = timeFormatted;
      labelColor = '#22c55e';
      timeColor = '#22c55e';
      pillBg = 'rgba(34, 197, 94, 0.12)';
      pillBorder = 'rgba(34, 197, 94, 0.35)';
      pillTitle = `当前会话任务执行中: 已耗时 ${timeFormatted}\n单击展开详情与 Token 统计`;
    } else if (isError) {
      dotColor = '#ef4444';
      isPulse = false;
      labelText = '已失败';
      timeText = timeFormatted;
      labelColor = '#ef4444';
      timeColor = '#ef4444';
      pillBg = 'rgba(239, 68, 68, 0.12)';
      pillBorder = 'rgba(239, 68, 68, 0.35)';
      pillTitle = `任务执行失败 (耗时: ${timeFormatted})\n单击查看详情`;
    } else if (hasElapsed) {
      dotColor = '#94a3b8';
      isPulse = false;
      labelText = '已完成';
      timeText = timeFormatted;
      labelColor = 'var(--foreground, #e5e7eb)';
      timeColor = '#94a3b8';
      pillBg = 'var(--card, rgba(255,255,255,0.06))';
      pillBorder = 'var(--border, rgba(255,255,255,0.12))';
      pillTitle = `当前会话任务就绪 (上次耗时: ${timeFormatted})\n单击展开详情与 Token 统计`;
    } else {
      dotColor = '#94a3b8';
      isPulse = false;
      labelText = '任务';
      timeText = '就绪';
      labelColor = 'var(--foreground, #e5e7eb)';
      timeColor = '#94a3b8';
      pillBg = 'var(--card, rgba(255,255,255,0.06))';
      pillBorder = 'var(--border, rgba(255,255,255,0.12))';
      pillTitle = '当前会话任务就绪\n单击展开详情与 Token 统计';
    }

    pill.style.background = pillBg;
    pill.style.borderColor = pillBorder;
    pill.title = pillTitle;

    if (!dotEl || !labelEl || !timeEl || !spacerEl) {
      pill.innerHTML = `
        <span id="agy-task-pill-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dotColor};box-shadow:${isPulse ? '0 0 6px rgba(34,197,94,0.8)' : 'none'};animation:${isPulse ? 'agy-pulse-dot 1.5s infinite' : 'none'};flex-shrink:0;"></span>
        <span id="agy-task-pill-label" style="font-weight:500;opacity:0.9;line-height:18px;margin-right:4px;color:${labelColor};">${labelText}</span>
        <span id="agy-task-pill-time" style="font-weight:600;color:${timeColor};font-family:${FONT_MONO};letter-spacing:0.3px;line-height:18px;">${timeText}</span>
        <span id="agy-task-pill-spacer" style="display:inline-block;width:7px;height:7px;flex-shrink:0;visibility:hidden;pointer-events:none;"></span>
      `;
    } else {
      dotEl.style.background = dotColor;
      dotEl.style.boxShadow = isPulse ? '0 0 6px rgba(34,197,94,0.8)' : 'none';
      dotEl.style.animation = isPulse ? 'agy-pulse-dot 1.5s infinite' : 'none';

      if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
      labelEl.style.color = labelColor;

      if (timeEl.textContent !== timeText) timeEl.textContent = timeText;
      timeEl.style.color = timeColor;
    }
  }

  // =========================================================================
  // 本地每秒平滑秒表递增与后台同步
  // =========================================================================
  function tickTimer() {
    if (window.__AGY_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;

    // 路由感应守卫：如果当前窗口的会话发生变动，立即触发刷新
    const curId = getCurrentWindowConvId();
    if (curId !== (activeTaskState?.id || null)) {
      refreshTaskOnly(false);
      return;
    }

    if (activeTaskState && activeTaskState.isRunning && activeTaskState.userStartTime) {
      const calculated = Math.max(0, Math.floor((Date.now() - activeTaskState.userStartTime) / 1000));
      // 严格单调不减：新值大于既有值时才推进一步，彻底杜绝回退
      if (calculated > (activeTaskState.elapsedSec || 0)) {
        activeTaskState.elapsedSec = calculated;

        const timeFormatted = formatTaskDuration(calculated);
        const timeNumEl = document.getElementById('agy-task-pill-time');
        if (timeNumEl && timeNumEl.textContent !== timeFormatted) {
          timeNumEl.textContent = timeFormatted;
        }

        const popoverTimerEl = document.getElementById('agy-task-popover-timer');
        if (popoverTimerEl && popoverTimerEl.textContent !== timeFormatted) {
          popoverTimerEl.textContent = timeFormatted;
        }
      }
    }
  }

  async function refreshTaskOnly(force = false) {
    if (window.__AGY_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;
    const raw = await fetchTaskStatus();
    if (window.__AGY_ACTIVE_INSTANCE_ID__ !== WIDGET_INSTANCE_ID) return;

    activeTaskState = resolveActiveTaskFast(raw);
    updateTaskTimerPill(activeTaskState);
    renderTaskPopoverContent(activeTaskState);

    // 智能节流深入解析 Token 与工具调用：仅当步骤变动、时间戳变动或新轮次触发且间隔 > 2000ms 时才执行
    if (activeTaskState?.id) {
      const activeId = activeTaskState.id;
      const lastMod = activeTaskState.lastModTime;
      const currentSteps = activeTaskState.lastStepCount;
      const cached = tokenMetricsCache.get(activeId);

      const shouldFetch = force || !cached || (Date.now() - lastTokenFetchTime > 2000 && (cached.lastModTime !== lastMod || cached.lastStepCount !== currentSteps));

      if (shouldFetch && !isFetchingTokenMetrics) {
        fetchTurnTokenMetrics(activeId, lastMod).then(tokenMetrics => {
          if (tokenMetrics && activeTaskState && activeTaskState.id === activeId) {
            tokenMetricsCache.set(activeId, { lastModTime: lastMod, lastStepCount: currentSteps, data: tokenMetrics });

            activeTaskState.stepCount = tokenMetrics.turnStepCount;
            activeTaskState.outTokens = tokenMetrics.outTokens;
            activeTaskState.cacheTokens = tokenMetrics.cacheTokens;
            activeTaskState.inTokens = tokenMetrics.inTokens;
            activeTaskState.activeTool = tokenMetrics.activeTool;
            if (tokenMetrics.startTime && !activeTaskState.userStartTime) {
              activeTaskState.userStartTime = tokenMetrics.startTime;
            }

            if (tokenMetrics.isCompleted) {
              activeTaskState.isRunning = false;
              if (tokenMetrics.elapsedSec) activeTaskState.elapsedSec = tokenMetrics.elapsedSec;
            } else if (!activeTaskState.isRunning) {
              if (tokenMetrics.elapsedSec) activeTaskState.elapsedSec = tokenMetrics.elapsedSec;
            }

            updateTaskTimerPill(activeTaskState);
            renderTaskPopoverContent(activeTaskState);
          }
        });
      }
    }
  }

  function setupPollingTimer() {
    if (window.__AGY_TASK_POLL_TIMER__) {
      clearInterval(window.__AGY_TASK_POLL_TIMER__);
      window.__AGY_TASK_POLL_TIMER__ = null;
    }
    window.__AGY_TASK_POLL_TIMER__ = setInterval(() => {
      refreshTaskOnly(false);
    }, 1000);
  }

  // 点击外部收起
  function onDocumentClick(e) {
    const taskPill = document.getElementById('agy-task-timer-topbar');
    const taskPopover = document.getElementById('agy-task-popover');
    if (taskPill && taskPill.contains(e.target)) return;
    if (taskPopover && taskPopover.contains(e.target)) return;
    closeTaskPopover(true);
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
    }, 200);
  });

  // 安全启动
  let retryTimer = null;
  function startObserverAndMount() {
    const root = document.querySelector('.bg-sidebar') || document.body || document.documentElement;
    if (root) {
      try {
        observer.observe(root, { childList: true, subtree: true });
      } catch (_) {}
    }
    refreshTaskOnly(true);
    setupPollingTimer();

    if (window.__AGY_TASK_TICK_TIMER__) {
      clearInterval(window.__AGY_TASK_TICK_TIMER__);
    }
    window.__AGY_TASK_TICK_TIMER__ = setInterval(tickTimer, 1000);

    let retryCount = 0;
    retryTimer = setInterval(() => {
      retryCount++;
      const taskPill = document.getElementById('agy-task-timer-topbar');
      if (!taskPill) {
        updateTaskTimerPill(activeTaskState);
      }
      if (taskPill || retryCount >= 8) {
        clearInterval(retryTimer);
        retryTimer = null;
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

  // Hook HTML5 History API 实现单页路由切换毫秒级响应
  try {
    if (!window.__AGY_HISTORY_HOOKED__) {
      window.__AGY_HISTORY_HOOKED__ = true;
      const _origPush = history.pushState;
      history.pushState = function(...args) {
        const ret = _origPush.apply(this, args);
        window.dispatchEvent(new CustomEvent('agy:routechange'));
        return ret;
      };
      const _origReplace = history.replaceState;
      history.replaceState = function(...args) {
        const ret = _origReplace.apply(this, args);
        window.dispatchEvent(new CustomEvent('agy:routechange'));
        return ret;
      };
    }
  } catch (_) {}

  const onPopState = () => refreshTaskOnly(false);
  window.addEventListener('popstate', onPopState);

  const onRouteChange = () => refreshTaskOnly(false);
  window.addEventListener('agy:routechange', onRouteChange);

  // 毫秒级捕获会话标签、新建会话按钮与侧边栏点击
  const onPointerUp = (e) => {
    const target = e.target;
    if (target && target.closest && (
      target.closest('a[href]') ||
      target.closest('[data-testid="new-conversation-button"]') ||
      target.closest('.tabs-container') ||
      target.closest('.monaco-list') ||
      target.closest('[role="tab"]') ||
      target.closest('.activitybar')
    )) {
      setTimeout(() => refreshTaskOnly(false), 30);
    }
  };
  document.addEventListener('pointerup', onPointerUp, true);

  window.__AGY_TASK_TIMER_CLEANUP__ = () => {
    observer.disconnect();
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('agy:routechange', onRouteChange);
    if (window.__AGY_TASK_POLL_TIMER__) {
      clearInterval(window.__AGY_TASK_POLL_TIMER__);
      window.__AGY_TASK_POLL_TIMER__ = null;
    }
    if (window.__AGY_TASK_TICK_TIMER__) {
      clearInterval(window.__AGY_TASK_TICK_TIMER__);
      window.__AGY_TASK_TICK_TIMER__ = null;
    }
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    window.removeEventListener('focus', onWindowActivate);
    removeEl('agy-task-timer-topbar');
    removeEl('agy-task-popover');
  };
})();

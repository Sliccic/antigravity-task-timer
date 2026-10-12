/**
 * Live Hot-Injection Script for Google Antigravity Task Timer
 * 通过 Chrome DevTools 协议实现任务耗时与 Token 统计插件零重启即时热加载
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { SimpleWebSocketClient } = require('../src/cdp-client');

function getDevToolsPort() {
  const possiblePaths = [
    path.join(process.env.APPDATA || '', 'antigravity', 'DevToolsActivePort'),
    path.join(process.env.LOCALAPPDATA || '', 'antigravity', 'DevToolsActivePort'),
    path.join(process.env.HOME || '', '.config', 'antigravity', 'DevToolsActivePort'),
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'antigravity', 'DevToolsActivePort')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const line = fs.readFileSync(p, 'utf8').split('\n')[0].trim();
        const port = parseInt(line, 10);
        if (!isNaN(port) && port > 0) return port;
      } catch (_) {}
    }
  }
  return null;
}

async function hotInject() {
  const port = getDevToolsPort();
  if (!port) {
    console.error('❌ 未检测到 Antigravity 运行实例或未开放 DevTools 端口。');
    console.error('💡 提示：请确保客户端处于打开状态。');
    process.exit(1);
  }

  console.log(`🔌 检测到 DevTools 调试端口: ${port}`);

  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });

  const page = targets.find(t => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) {
    console.error('❌ 未在端口上找到活跃的渲染窗口页面。');
    process.exit(1);
  }

  console.log(`🎯 连接到主窗口 WebSocket: ${page.webSocketDebuggerUrl}`);
  const client = new SimpleWebSocketClient(page.webSocketDebuggerUrl);
  await client.connect();

  const widgetPath = path.join(__dirname, '..', 'src', 'task-timer-widget.js');
  const widgetCode = fs.readFileSync(widgetPath, 'utf8');

  console.log('⚡ 正在向客户端注入任务耗时与 Token 统计胶囊...');
  await client.send('Runtime.evaluate', {
    expression: widgetCode,
    returnByValue: true
  });

  console.log('✅ 热注入成功！任务耗时胶囊已在 Antigravity 顶栏即时呈现。');
  client.close();
}

if (require.main === module) {
  hotInject().catch(err => {
    console.error('❌ 注入失败:', err);
    process.exit(1);
  });
}

module.exports = { hotInject };

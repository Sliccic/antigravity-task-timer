#!/usr/bin/env node

/**
 * Antigravity Task Timer & Metrics Monitor CLI
 */

const { install } = require('../scripts/installer');
const { hotInject } = require('../scripts/hot-inject');
const { restore } = require('../scripts/restore');

const command = process.argv[2] || 'install';

async function main() {
  switch (command) {
    case 'install':
      await install();
      break;
    case 'hot-inject':
    case 'hot-reload':
    case 'inject':
      await hotInject();
      break;
    case 'restore':
    case 'uninstall':
      restore();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(`
Antigravity Task Timer & Metrics Monitor CLI
使用方法:
  npx antigravity-task-timer install      # 安装并注入补丁包到 app.asar
  npx antigravity-task-timer hot-reload   # 零重启即时热注入到运行中窗口
  npx antigravity-task-timer restore      # 卸载任务计时器并恢复
      `);
      break;
    default:
      console.error(`未知命令: ${command}，输入 --help 查看支持命令。`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

/**
 * Restore / Uninstall Antigravity Task Timer
 * 一键卸载与安全复原
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { findAsarPath } = require('./installer');

function restore() {
  const asarPath = findAsarPath();
  if (!asarPath) {
    console.error('❌ 未找到 app.asar 路径。');
    process.exit(1);
  }

  const asarDir = path.dirname(asarPath);
  const tempExtractDir = path.join(os.tmpdir(), `agy_task_restore_${Date.now()}`);
  fs.mkdirSync(tempExtractDir, { recursive: true });

  try {
    execSync(`npx --yes @electron/asar extract "${asarPath}" "${tempExtractDir}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error('❌ 解包 ASAR 失败:', e.message);
    process.exit(1);
  }

  const preloadPath = path.join(tempExtractDir, 'dist', 'preload.js');
  if (fs.existsSync(preloadPath)) {
    let content = fs.readFileSync(preloadPath, 'utf8');
    if (content.includes('Antigravity Task Timer Start')) {
      const regexTimer = /\/\/ --- Antigravity Task Timer Start ---[\s\S]*?\/\/ --- Antigravity Task Timer End ---/g;
      content = content.replace(regexTimer, '');
      fs.writeFileSync(preloadPath, content, 'utf8');
      console.log('✅ 已从 preload.js 移除任务计时器模块。');
    } else {
      console.log('ℹ️ preload.js 中未检测到任务计时器注入代码。');
    }
  }

  const tempNewAsar = path.join(asarDir, 'app.asar.new');
  if (fs.existsSync(tempNewAsar)) fs.rmSync(tempNewAsar, { force: true });

  try {
    execSync(`npx --yes @electron/asar pack "${tempExtractDir}" "${tempNewAsar}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error('❌ 打包 ASAR 失败:', e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (_) {}
  }

  try {
    fs.copyFileSync(tempNewAsar, asarPath);
    fs.rmSync(tempNewAsar, { force: true });
    console.log('✨ [完成] 已成功卸载任务计时器并更新 app.asar！');
  } catch (e) {
    console.error('❌ 覆写失败 (文件被占用，请退出 Antigravity 后再试):', e.message);
  }
}

if (require.main === module) {
  restore();
}

module.exports = { restore };

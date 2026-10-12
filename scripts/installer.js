/**
 * Cross-Platform Installer for Antigravity Session Task Timer & Metrics Widget
 * 跨平台智能安装器（支持 Windows / macOS / Linux，支持主世界注入、在位直写与零重启热重载）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { hotInject } = require('./hot-inject');

function getCandidateAsarPaths() {
  const homedir = os.homedir();
  const platform = os.platform();

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(homedir, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    ];
  } else if (platform === 'darwin') {
    return [
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(homedir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    ];
  } else {
    return [
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(homedir, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    ];
  }
}

function findAsarPath() {
  const candidates = getCandidateAsarPaths();
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isProcessRunning() {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf8' });
      return out.toLowerCase().includes('antigravity.exe');
    } else {
      const out = execSync('pgrep -i antigravity || true', { encoding: 'utf8' });
      return !!out.trim();
    }
  } catch (_) {
    return false;
  }
}

async function install() {
  console.log('🚀 [1/4] 正在检测系统环境与 Antigravity 客户端路径...');
  const asarPath = findAsarPath();
  if (!asarPath) {
    console.error('❌ 未能自动找到 Antigravity 的 app.asar 文件。');
    console.error('请确认已安装 Antigravity 桌面客户端。');
    process.exit(1);
  }

  console.log(`   ✅ 目标 ASAR: ${asarPath}`);
  const asarDir = path.dirname(asarPath);
  const backupPath = path.join(asarDir, 'app.asar.bak');

  console.log('📦 [2/4] 检查原始安全备份...');
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(asarPath, backupPath);
      console.log(`   ✅ 已备份原始文件至: ${backupPath}`);
    } catch (e) {
      console.warn(`   ⚠️ 备份时遇到提示: ${e.message}`);
    }
  } else {
    console.log(`   ℹ️ 保留已有官方出厂备份: ${backupPath}`);
  }

  console.log('⚙️ [3/4] 解构并注入任务耗时与 Token 监控插件...');
  const tempExtractDir = path.join(os.tmpdir(), `agy_task_patch_${Date.now()}`);
  fs.mkdirSync(tempExtractDir, { recursive: true });

  try {
    execSync(`npx --yes @electron/asar extract "${asarPath}" "${tempExtractDir}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error('❌ 解包 ASAR 失败，请检查 Node.js/npx 环境:', e.message);
    process.exit(1);
  }

  const widgetPath = path.join(__dirname, '..', 'src', 'task-timer-widget.js');
  const widgetCode = fs.readFileSync(widgetPath, 'utf8');

  // 构建支持主世界隔离穿透的注入包装体 (Main World Context Bridge)
  const injectionWrapper = `
// --- Antigravity Task Timer Start ---
(function() {
  function __agy_inject_task_timer__() {
    try {
      const { webFrame } = require('electron');
      if (webFrame && typeof webFrame.executeJavaScript === 'function') {
        webFrame.executeJavaScript(${JSON.stringify(widgetCode)});
        return;
      }
    } catch (_) {}

    try {
      const s = document.createElement('script');
      s.textContent = ${JSON.stringify(widgetCode)};
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) {
      console.error('[AGY-TaskTimer] Main world injection error:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __agy_inject_task_timer__);
  } else {
    __agy_inject_task_timer__();
  }
})();
// --- Antigravity Task Timer End ---
`;

  let patched = false;
  const preloadPath = path.join(tempExtractDir, 'dist', 'preload.js');
  if (fs.existsSync(preloadPath)) {
    let content = fs.readFileSync(preloadPath, 'utf8');
    if (content.includes('Antigravity Task Timer Start')) {
      const regexTimer = /\/\/ --- Antigravity Task Timer Start ---[\s\S]*?\/\/ --- Antigravity Task Timer End ---/g;
      content = content.replace(regexTimer, '');
    }
    content += '\n' + injectionWrapper;
    fs.writeFileSync(preloadPath, content, 'utf8');
    patched = true;
  }

  if (!patched) {
    console.error('❌ 未能在 ASAR 内找到 dist/preload.js 入口文件。');
    process.exit(1);
  }

  console.log('🔄 [4/4] 重新打包资源包并覆写应用...');
  const tempNewAsar = path.join(asarDir, 'app.asar.new');
  if (fs.existsSync(tempNewAsar)) fs.rmSync(tempNewAsar, { force: true });

  try {
    execSync(`npx --yes @electron/asar pack "${tempExtractDir}" "${tempNewAsar}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error('❌ 打包 ASAR 失败:', e.message);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } catch (_) {}
  }

  let writtenDirectly = false;
  try {
    fs.copyFileSync(tempNewAsar, asarPath);
    fs.rmSync(tempNewAsar, { force: true });
    writtenDirectly = true;
  } catch (_) {
    writtenDirectly = false;
  }

  if (writtenDirectly) {
    console.log('✨ [完成] app.asar 注入完成！');
  } else {
    console.log('⚠️ 目标文件正被锁定，尝试安排更新替换...');
    try {
      fs.renameSync(tempNewAsar, asarPath);
      console.log('✨ [完成] 替换成功！');
    } catch (_) {
      console.log('💡 请重启 Antigravity 即可完全生效。');
    }
  }

  const running = isProcessRunning();
  if (running) {
    console.log('\n⚡ 检测到 Antigravity 正在运行，尝试通过 CDP 执行零重启热重载...');
    try {
      await hotInject();
    } catch (e) {
      console.log(`ℹ️ 热加载提示: ${e.message}。下次启动客户端时将自动加载。`);
    }
  } else {
    console.log('\n🎉 安装成功！启动 Antigravity 客户端即可享受任务耗时与 Token 监控。');
  }
}

if (require.main === module) {
  install().catch(e => {
    console.error('安装过程中出现异常:', e);
    process.exit(1);
  });
}

module.exports = { install };

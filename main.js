const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let monitorInterval = null;
let autoOptimizeInterval = null;
let isQuitting = false;
let lastOptimizeTime = 0;
let lastAlertTime = 0;

// Default settings
let settings = {
  autoOptimize: false,
  memoryThreshold: 80,
  checkInterval: 30,
  minProcessSize: 100,
  cooldown: 5,
  alertThreshold: 70,
  alertTray: true,
  alertSound: true,
  theme: 'dark',
  blacklist: [
    'System', 'smss.exe', 'csrss.exe', 'wininit.exe',
    'services.exe', 'lsass.exe', 'svchost.exe',
    'explorer.exe', 'dwm.exe', 'sihost.exe',
    'SecurityHealthService.exe', 'Memory Optimizer'
  ]
};

// Try to load saved settings
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// Helper: get full PowerShell path for reliable execution in packaged app
function getPsPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Helper: run a PowerShell script by writing it to temp file first (avoids ASAR & escaping issues)
function runPsScript(scriptContent, options = {}) {
  return new Promise((resolve) => {
    const psPath = getPsPath();
    const tempFile = path.join(app.getPath('temp'), `mo-script-${Date.now()}.ps1`);

    try {
      fs.writeFileSync(tempFile, scriptContent, 'utf8');
    } catch (e) {
      console.error('Failed to write temp PS script:', e);
      resolve({ error: e, stdout: '' });
      return;
    }

    const execOptions = {
      maxBuffer: options.maxBuffer || 1024 * 1024 * 5,
      timeout: options.timeout || 15000
    };

    exec(`"${psPath}" -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, execOptions, (error, stdout) => {
      // Clean up temp file
      try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      resolve({ error, stdout: stdout || '' });
    });
  });
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings = { ...settings, ...saved };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Memory Optimizer',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false,
    transparent: false,
    backgroundColor: '#0a0e17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(
    createTrayIconBuffer(), { width: 16, height: 16 }
  ));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '⚡ 즉시 최적화',
      click: () => optimizeAll()
    },
    {
      label: '자동 최적화',
      type: 'checkbox',
      checked: settings.autoOptimize,
      click: (menuItem) => {
        settings.autoOptimize = menuItem.checked;
        saveSettings();
        setupAutoOptimizer();
        if (mainWindow) {
          mainWindow.webContents.send('settings-updated', settings);
        }
      }
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Memory Optimizer');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createTrayIconBuffer() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const pattern = [
    '................',
    '....######......',
    '...########.....',
    '..##..##..##....',
    '..#..####..#....',
    '..#.######.#....',
    '..#.######.#....',
    '..##.####.##....',
    '...##.##.##.....',
    '...########.....',
    '....######......',
    '.....####.......',
    '......##........',
    '................',
    '................',
    '................'
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (pattern[y][x] === '#') {
        buffer[idx] = 0;
        buffer[idx + 1] = 255;
        buffer[idx + 2] = 136;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx + 3] = 0;
      }
    }
  }
  return buffer;
}

// ========== Memory Monitoring ==========

function getMemoryInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usagePercent = Math.round((usedMem / totalMem) * 100);
  return { total: totalMem, used: usedMem, free: freeMem, usagePercent };
}

function getCpuUsage() {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();
    setTimeout(() => {
      const cpus2 = os.cpus();
      let totalIdle = 0, totalTick = 0;
      for (let i = 0; i < cpus2.length; i++) {
        const c1 = cpus1[i].times;
        const c2 = cpus2[i].times;
        const idle = c2.idle - c1.idle;
        const total = (c2.user - c1.user) + (c2.nice - c1.nice) +
          (c2.sys - c1.sys) + (c2.irq - c1.irq) + idle;
        totalIdle += idle;
        totalTick += total;
      }
      resolve(Math.round((1 - totalIdle / totalTick) * 100));
    }, 500);
  });
}

async function getProcessList() {
  const script = [
    "Get-Process | Select-Object Id,ProcessName,",
    "@{Name='MemoryMB';Expression={[math]::Round($_.WorkingSet64/1MB,1)}},",
    "@{Name='CPU';Expression={if($_.CPU){[math]::Round($_.CPU,1)}else{0}}} |",
    "Sort-Object MemoryMB -Descending | Select-Object -First 50 | ConvertTo-Json"
  ].join(' ');

  const { error, stdout } = await runPsScript(script, { timeout: 15000 });

  if (error) {
    console.error('getProcessList error:', error.message);
    return [];
  }

  try {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    let processes = JSON.parse(trimmed);
    if (!Array.isArray(processes)) processes = [processes];

    return processes.map(p => ({
      pid: p.Id || 0,
      name: p.ProcessName || 'Unknown',
      memoryMB: (typeof p.MemoryMB === 'number') ? p.MemoryMB : 0,
      cpu: (typeof p.CPU === 'number') ? p.CPU : 0
    }));
  } catch (e) {
    console.error('getProcessList parse error:', e.message);
    return [];
  }
}

// History buffer (ring buffer)
const MAX_HISTORY = 2880;
let memoryHistory = [];
let optimizeEvents = [];

function addHistoryPoint(memInfo) {
  memoryHistory.push({
    time: Date.now(),
    usage: memInfo.usagePercent,
    used: memInfo.used,
    free: memInfo.free
  });
  if (memoryHistory.length > MAX_HISTORY) {
    memoryHistory.shift();
  }
}

async function collectAndSend() {
  try {
    const memInfo = getMemoryInfo();
    const processes = await getProcessList();

    if (memoryHistory.length === 0 ||
      Date.now() - memoryHistory[memoryHistory.length - 1].time >= 30000) {
      addHistoryPoint(memInfo);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('monitor-data', {
        memory: memInfo,
        processes,
        historyLength: memoryHistory.length
      });
    }

    if (tray) {
      tray.setToolTip(`Memory Optimizer - ${memInfo.usagePercent}% 사용 중`);
    }

    // Alert check (with 5 minute cooldown to prevent spam)
    const alertCooldownMs = 5 * 60 * 1000;
    if (memInfo.usagePercent >= settings.alertThreshold) {
      const now = Date.now();
      if (settings.alertTray && (now - lastAlertTime >= alertCooldownMs)) {
        lastAlertTime = now;
        const notification = new Notification({
          title: '⚠️ 메모리 경고',
          body: `메모리 사용률이 ${memInfo.usagePercent}%입니다.`,
          silent: !settings.alertSound
        });
        notification.show();
      }
    }

    // Auto optimize check
    if (settings.autoOptimize && memInfo.usagePercent >= settings.memoryThreshold) {
      const now = Date.now();
      const cooldownMs = settings.cooldown * 60 * 1000;
      if (now - lastOptimizeTime >= cooldownMs) {
        optimizeAll();
      }
    }
  } catch (err) {
    console.error('Monitor error:', err);
  }
}

function startMonitoring() {
  collectAndSend();
  monitorInterval = setInterval(collectAndSend, 3000);
}

function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

// ========== Memory Optimization ==========

async function trimProcessMemory(pid) {
  const script = [
    'try {',
    `  $p = Get-Process -Id ${pid} -ErrorAction Stop`,
    '  $beforeMB = [math]::Round($p.WorkingSet64/1MB,1)',
    "  $type = Add-Type -MemberDefinition '[DllImport(\"psapi.dll\")]public static extern bool EmptyWorkingSet(IntPtr hProcess);' -Name 'ws' -Namespace 'win' -PassThru",
    '  [void]$type::EmptyWorkingSet($p.Handle)',
    '  Start-Sleep -Milliseconds 100',
    '  $p.Refresh()',
    '  $afterMB = [math]::Round($p.WorkingSet64/1MB,1)',
    '  Write-Output "$beforeMB|$afterMB"',
    '} catch {',
    "  Write-Output '0|0'",
    '}'
  ].join('\r\n');

  const { error, stdout } = await runPsScript(script, { timeout: 10000 });

  if (error) {
    return { success: false, freed: 0 };
  }
  try {
    const parts = stdout.trim().split('|');
    const before = parseFloat(parts[0]);
    const after = parseFloat(parts[1]);
    const freed = Math.max(0, before - after);
    return { success: true, freed, before, after };
  } catch (e) {
    return { success: false, freed: 0 };
  }
}

async function optimizeAll() {
  const processes = await getProcessList();
  const blacklistLower = settings.blacklist.map(b => b.toLowerCase().replace('.exe', ''));

  let totalFreed = 0;
  let processedCount = 0;
  let results = [];

  for (const proc of processes) {
    if (blacklistLower.includes(proc.name.toLowerCase())) continue;
    if (proc.pid <= 4) continue;
    if (proc.memoryMB < settings.minProcessSize) continue;

    const result = await trimProcessMemory(proc.pid);
    if (result.success && result.freed > 0) {
      totalFreed += result.freed;
      processedCount++;
      results.push({
        name: proc.name,
        pid: proc.pid,
        freed: result.freed,
        before: result.before,
        after: result.after
      });
    }
  }

  lastOptimizeTime = Date.now();

  optimizeEvents.push({
    time: Date.now(),
    freed: totalFreed,
    processCount: processedCount
  });
  if (optimizeEvents.length > 100) optimizeEvents.shift();

  const report = { totalFreed, processedCount, results, timestamp: Date.now() };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('optimize-complete', report);
  }

  return report;
}

function setupAutoOptimizer() {
  if (autoOptimizeInterval) {
    clearInterval(autoOptimizeInterval);
    autoOptimizeInterval = null;
  }
}

// ========== Startup Program Management ==========

const disabledStartupsPath = path.join(app.getPath('userData'), 'disabled-startups.json');

function loadDisabledStartups() {
  try {
    if (fs.existsSync(disabledStartupsPath)) {
      return JSON.parse(fs.readFileSync(disabledStartupsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load disabled startups:', e);
  }
  return {};
}

function saveDisabledStartups(data) {
  try {
    fs.writeFileSync(disabledStartupsPath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save disabled startups:', e);
  }
}

async function getStartupPrograms() {
  // PowerShell script written to temp file (avoids ASAR file access issues)
  const script = [
    '$results = @()',
    'try {',
    "  $hkcuPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    '  if (Test-Path $hkcuPath) {',
    '    $props = Get-ItemProperty -Path $hkcuPath -ErrorAction SilentlyContinue',
    "    $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {",
    "      $results += [pscustomobject]@{ Name=$_.Name; Command=$_.Value; Location='HKCU'; RegistryPath=$hkcuPath; Type='Registry' }",
    '    }',
    '  }',
    '} catch {}',
    'try {',
    "  $hklmPath = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    '  if (Test-Path $hklmPath) {',
    '    $props = Get-ItemProperty -Path $hklmPath -ErrorAction SilentlyContinue',
    "    $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {",
    "      $results += [pscustomobject]@{ Name=$_.Name; Command=$_.Value; Location='HKLM'; RegistryPath=$hklmPath; Type='Registry' }",
    '    }',
    '  }',
    '} catch {}',
    'try {',
    "  $sf = [System.Environment]::GetFolderPath('Startup')",
    '  if (Test-Path $sf) {',
    '    Get-ChildItem $sf -File | ForEach-Object {',
    "      $results += [pscustomobject]@{ Name=$_.BaseName; Command=$_.FullName; Location='StartupFolder'; RegistryPath=$sf; Type='Shortcut' }",
    '    }',
    '  }',
    '} catch {}',
    'try {',
    '  Get-ScheduledTask | Where-Object {',
    "    $_.State -ne 'Disabled' -and ($_.Triggers | Where-Object { $_ -is [CimInstance] -and $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })",
    '  } | Select-Object -First 20 | ForEach-Object {',
    '    $a = ($_.Actions | Select-Object -First 1).Execute',
    "    if ($a) { $results += [pscustomobject]@{ Name=$_.TaskName; Command=$a; Location='TaskScheduler'; RegistryPath=$_.TaskPath; Type='Task' } }",
    '  }',
    '} catch {}',
    "if ($results.Count -eq 0) { Write-Output '[]' } else { $results | ConvertTo-Json -Depth 3 }"
  ].join('\r\n');

  const { error, stdout } = await runPsScript(script, { timeout: 15000 });

  if (error) {
    console.error('Failed to get startup programs:', error.message);
    return [];
  }

  try {
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return [];
    let items = JSON.parse(trimmed);
    if (!Array.isArray(items)) items = [items];

    const disabled = loadDisabledStartups();

    return items.map(item => ({
      name: item.Name || 'Unknown',
      command: item.Command || '',
      location: item.Location || 'Unknown',
      registryPath: item.RegistryPath || '',
      type: item.Type || 'Unknown',
      enabled: !disabled[`${item.Location}::${item.Name}`],
      id: `${item.Location}::${item.Name}`
    }));
  } catch (e) {
    console.error('Parse startup items failed:', e.message);
    return [];
  }
}

function toggleStartupProgram(id, enable) {
  return new Promise((resolve) => {
    const psPath = getPsPath();
    const disabled = loadDisabledStartups();
    const parts = id.split('::');
    const location = parts[0];
    const name = parts.slice(1).join('::');
    const safeName = name.replace(/'/g, "''");

    if (location === 'HKCU' || location === 'HKLM') {
      const regRoot = location === 'HKCU' ? 'HKCU' : 'HKLM';
      const runPath = regRoot + ':\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

      if (enable) {
        if (disabled[id]) {
          const command = disabled[id].command;
          const safeCmd = command.replace(/'/g, "''");
          const script = `Set-ItemProperty -Path '${runPath}' -Name '${safeName}' -Value '${safeCmd}'`;
          runPsScript(script, { timeout: 10000 }).then(({ error: err }) => {
            if (!err) {
              delete disabled[id];
              saveDisabledStartups(disabled);
              resolve({ success: true, message: `${name} 시작 프로그램이 활성화되었습니다.` });
            } else {
              resolve({ success: false, message: `활성화 실패: ${err.message}` });
            }
          });
        } else {
          resolve({ success: false, message: '복원할 데이터가 없습니다.' });
        }
      } else {
        const getScript = `(Get-ItemProperty -Path '${runPath}' -Name '${safeName}' -ErrorAction SilentlyContinue).'${safeName}'`;
        runPsScript(getScript, { timeout: 10000 }).then(({ error: err, stdout }) => {
          const currentCommand = stdout ? stdout.trim() : '';
          if (currentCommand) {
            const delScript = `Remove-ItemProperty -Path '${runPath}' -Name '${safeName}' -ErrorAction SilentlyContinue`;
            runPsScript(delScript, { timeout: 10000 }).then(({ error: err2 }) => {
              if (!err2) {
                disabled[id] = { command: currentCommand, name, location, disabledAt: Date.now() };
                saveDisabledStartups(disabled);
                resolve({ success: true, message: `${name} 시작 프로그램이 비활성화되었습니다.` });
              } else {
                resolve({ success: false, message: `비활성화 실패: ${err2.message}` });
              }
            });
          } else {
            disabled[id] = { command: '', name, location, disabledAt: Date.now() };
            saveDisabledStartups(disabled);
            resolve({ success: true, message: `${name} 비활성화 처리되었습니다.` });
          }
        });
      }
    } else if (location === 'TaskScheduler') {
      const action = enable ? 'Enable' : 'Disable';
      const script = `${action}-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue`;
      runPsScript(script, { timeout: 10000 }).then(({ error: err }) => {
        if (!err) {
          if (enable) {
            delete disabled[id];
          } else {
            disabled[id] = { command: '', name, location, disabledAt: Date.now() };
          }
          saveDisabledStartups(disabled);
          resolve({ success: true, message: `${name} 작업이 ${enable ? '활성화' : '비활성화'}되었습니다.` });
        } else {
          resolve({ success: false, message: `작업 ${enable ? '활성화' : '비활성화'} 실패: ${err.message}` });
        }
      });
    } else if (location === 'StartupFolder') {
      if (enable) {
        if (disabled[id] && disabled[id].command) {
          const disabledFilePath = disabled[id].command + '.disabled';
          try {
            if (fs.existsSync(disabledFilePath)) {
              fs.renameSync(disabledFilePath, disabled[id].command);
            }
            delete disabled[id];
            saveDisabledStartups(disabled);
            resolve({ success: true, message: `${name} 시작 항목이 활성화되었습니다.` });
          } catch (e) {
            resolve({ success: false, message: `활성화 실패: ${e.message}` });
          }
        } else {
          resolve({ success: false, message: '복원할 데이터가 없습니다.' });
        }
      } else {
        const disabled2 = loadDisabledStartups();
        const getFolder = "[System.Environment]::GetFolderPath('Startup')";
        runPsScript(getFolder, { timeout: 5000 }).then(({ error: err, stdout: folderOut }) => {
          if (err) {
            resolve({ success: false, message: '시작 폴더를 찾을 수 없습니다.' });
            return;
          }
          const folder = folderOut.trim();
          try {
            const files = fs.readdirSync(folder);
            const target = files.find(f => path.parse(f).name === name);
            if (target) {
              const fullPath = path.join(folder, target);
              fs.renameSync(fullPath, fullPath + '.disabled');
              disabled2[id] = { command: fullPath, name, location, disabledAt: Date.now() };
              saveDisabledStartups(disabled2);
              resolve({ success: true, message: `${name} 시작 항목이 비활성화되었습니다.` });
            } else {
              disabled2[id] = { command: '', name, location, disabledAt: Date.now() };
              saveDisabledStartups(disabled2);
              resolve({ success: true, message: `${name} 비활성화 처리되었습니다.` });
            }
          } catch (e) {
            resolve({ success: false, message: `비활성화 실패: ${e.message}` });
          }
        });
      }
    } else {
      resolve({ success: false, message: '지원하지 않는 시작 프로그램 유형입니다.' });
    }
  });
}

function getDisabledStartups() {
  const disabled = loadDisabledStartups();
  return Object.entries(disabled).map(([id, data]) => ({
    id,
    name: data.name,
    command: data.command,
    location: data.location,
    enabled: false,
    type: data.location === 'TaskScheduler' ? 'Task' :
      data.location === 'StartupFolder' ? 'Shortcut' : 'Registry',
    disabledAt: data.disabledAt
  }));
}

// ========== IPC Handlers ==========

ipcMain.handle('get-memory-info', () => getMemoryInfo());
ipcMain.handle('get-process-list', () => getProcessList());
ipcMain.handle('get-cpu-usage', () => getCpuUsage());

ipcMain.handle('trim-process', async (event, pid) => {
  return await trimProcessMemory(pid);
});

ipcMain.handle('optimize-all', async () => {
  return await optimizeAll();
});

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('save-settings', (event, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveSettings();
  setupAutoOptimizer();
  return settings;
});

ipcMain.handle('get-history', (event, range) => {
  const now = Date.now();
  let cutoff;
  switch (range) {
    case '1h': cutoff = now - 3600000; break;
    case '6h': cutoff = now - 21600000; break;
    case '24h': cutoff = now - 86400000; break;
    default: cutoff = now - 3600000;
  }
  return {
    data: memoryHistory.filter(h => h.time >= cutoff),
    events: optimizeEvents.filter(e => e.time >= cutoff)
  };
});

ipcMain.handle('get-startup-programs', async () => {
  const active = await getStartupPrograms();
  const disabled = getDisabledStartups();
  const activeIds = new Set(active.map(a => a.id));
  const merged = [...active];
  for (const d of disabled) {
    if (!activeIds.has(d.id)) {
      merged.push(d);
    }
  }
  return merged;
});

ipcMain.handle('toggle-startup', async (event, id, enable) => {
  return await toggleStartupProgram(id, enable);
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

// ========== App Lifecycle ==========

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();
  startMonitoring();
  setupAutoOptimizer();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopMonitoring();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

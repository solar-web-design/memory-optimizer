// ============================================
// Memory Optimizer - Renderer Process
// ============================================

(function () {
    'use strict';

    // ========== State ==========
    let currentView = 'dashboard';
    let currentSort = { key: 'memory', order: 'desc' };
    let selectedPids = new Set();
    let allProcesses = [];
    let searchQuery = '';
    let currentSettings = {};
    let cpuUsageValue = 0;
    let memoryAnimTarget = 0;
    let memoryAnimCurrent = 0;
    let cpuAnimTarget = 0;
    let cpuAnimCurrent = 0;
    let historyData = [];
    let historyEvents = [];

    // ========== DOM References ==========
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ========== Initialization ==========
    async function init() {
        setupWindowControls();
        setupNavigation();
        setupDashboardActions();
        setupProcessView();
        setupStartupView();
        setupSettings();
        startGaugeAnimation();

        // Load initial settings
        currentSettings = await window.api.getSettings();
        applySettingsToUI(currentSettings);

        // Listen for real-time data
        window.api.onMonitorData(handleMonitorData);
        window.api.onOptimizeComplete(handleOptimizeComplete);
        window.api.onSettingsUpdated((s) => {
            currentSettings = s;
            applySettingsToUI(s);
        });

        // Get initial CPU usage  
        updateCpuUsage();
        setInterval(updateCpuUsage, 5000);

        // Update history chart
        updateHistoryChart('1h');
        setInterval(() => updateHistoryChart(), 30000);
    }

    // ========== Window Controls ==========
    function setupWindowControls() {
        $('#btnMinimize').addEventListener('click', () => window.api.minimizeWindow());
        $('#btnMaximize').addEventListener('click', () => window.api.maximizeWindow());
        $('#btnClose').addEventListener('click', () => window.api.closeWindow());
    }

    // ========== Navigation ==========
    function setupNavigation() {
        $$('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                switchView(view);
            });
        });

        $('#btnShowAllProcesses').addEventListener('click', () => switchView('processes'));
    }

    function switchView(viewName) {
        currentView = viewName;
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        $(`.nav-btn[data-view="${viewName}"]`).classList.add('active');
        $$('.view').forEach(v => v.classList.remove('active'));
        $(`#view${capitalize(viewName)}`).classList.add('active');

        // Auto-load startup programs when switching to startup view
        if (viewName === 'startup' && startupPrograms.length === 0) {
            loadStartupPrograms();
        }
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ========== Dashboard ==========
    function setupDashboardActions() {
        $('#btnOptimizeAll').addEventListener('click', runOptimizeAll);
    }

    async function updateCpuUsage() {
        try {
            const cpu = await window.api.getCpuUsage();
            cpuAnimTarget = cpu;
            $('#cpuDetail').textContent = `${navigator.hardwareConcurrency || '?'} 코어`;
        } catch (e) { }
    }

    function handleMonitorData(data) {
        const { memory, processes } = data;

        // Update memory gauge
        memoryAnimTarget = memory.usagePercent;
        $('#memoryDetail').textContent = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;

        // Update free memory
        const freeGB = (memory.free / (1024 * 1024 * 1024)).toFixed(1);
        $('#freeMemValue').textContent = freeGB;
        const freePercent = Math.round((memory.free / memory.total) * 100);
        $('#freeMemBar').style.width = `${freePercent}%`;

        // Update auto optimize status
        const autoStatusDot = $('#autoStatusDot');
        const autoStatusText = $('#autoStatusText');
        if (currentSettings.autoOptimize) {
            autoStatusDot.classList.add('active');
            autoStatusText.textContent = `자동 최적화: 켜짐 (${currentSettings.memoryThreshold}% 초과 시)`;
        } else {
            autoStatusDot.classList.remove('active');
            autoStatusText.textContent = '자동 최적화: 꺼짐';
        }

        // Update processes
        allProcesses = processes;
        renderTopProcesses(processes);

        if (currentView === 'processes') {
            renderProcessTable();
        }
    }

    function renderTopProcesses(processes) {
        const container = $('#topProcessList');
        const top7 = processes.slice(0, 7);

        container.innerHTML = top7.map(p => {
            const statusClass = p.memoryMB >= 500 ? 'danger' : p.memoryMB >= 100 ? 'warn' : 'safe';
            const memClass = p.memoryMB >= 500 ? 'mem-danger' : p.memoryMB >= 100 ? 'mem-warn' : 'mem-safe';
            return `
        <div class="process-item">
          <div class="process-status ${statusClass}"></div>
          <span class="process-name">${escapeHtml(p.name)}</span>
          <span class="process-memory ${memClass}">${p.memoryMB.toFixed(1)} MB</span>
          <span class="process-cpu">${p.cpu.toFixed(1)}s CPU</span>
        </div>
      `;
        }).join('');
    }

    // ========== Gauge Animation ==========
    function startGaugeAnimation() {
        const memCanvas = $('#memoryGauge');
        const cpuCanvas = $('#cpuGauge');
        const memCtx = memCanvas.getContext('2d');
        const cpuCtx = cpuCanvas.getContext('2d');

        // Set canvas DPI
        const dpr = window.devicePixelRatio || 1;
        [memCanvas, cpuCanvas].forEach(c => {
            c.width = 180 * dpr;
            c.height = 180 * dpr;
            c.style.width = '180px';
            c.style.height = '180px';
            c.getContext('2d').scale(dpr, dpr);
        });

        function animate() {
            // Smooth animation
            memoryAnimCurrent += (memoryAnimTarget - memoryAnimCurrent) * 0.08;
            cpuAnimCurrent += (cpuAnimTarget - cpuAnimCurrent) * 0.08;

            drawGauge(memCtx, memoryAnimCurrent, 180);
            drawGauge(cpuCtx, cpuAnimCurrent, 180);

            $('#memoryPercent').textContent = `${Math.round(memoryAnimCurrent)}%`;
            $('#cpuPercent').textContent = `${Math.round(cpuAnimCurrent)}%`;

            // Update gauge value color
            updateGaugeColor('#memoryPercent', memoryAnimCurrent);
            updateGaugeColor('#cpuPercent', cpuAnimCurrent);

            requestAnimationFrame(animate);
        }

        animate();
    }

    function drawGauge(ctx, percent, size) {
        const cx = size / 2;
        const cy = size / 2;
        const radius = 72;
        const lineWidth = 10;
        const startAngle = -Math.PI * 0.75;
        const endAngle = Math.PI * 0.75;
        const totalAngle = endAngle - startAngle;

        ctx.clearRect(0, 0, size, size);

        // Background arc
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Value arc
        const valueAngle = startAngle + (totalAngle * (percent / 100));
        if (percent > 0) {
            const gradient = ctx.createLinearGradient(0, 0, size, size);
            if (percent >= 80) {
                gradient.addColorStop(0, '#ff4466');
                gradient.addColorStop(1, '#ff0044');
            } else if (percent >= 60) {
                gradient.addColorStop(0, '#ffaa00');
                gradient.addColorStop(1, '#ff8800');
            } else {
                gradient.addColorStop(0, '#00ff88');
                gradient.addColorStop(1, '#00d4ff');
            }

            ctx.beginPath();
            ctx.arc(cx, cy, radius, startAngle, valueAngle);
            ctx.strokeStyle = gradient;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.stroke();

            // Glow effect
            ctx.beginPath();
            ctx.arc(cx, cy, radius, startAngle, valueAngle);
            ctx.strokeStyle = percent >= 80 ? 'rgba(255, 68, 102, 0.3)' :
                percent >= 60 ? 'rgba(255, 170, 0, 0.3)' :
                    'rgba(0, 255, 136, 0.3)';
            ctx.lineWidth = lineWidth + 8;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Tick marks
        for (let i = 0; i <= 10; i++) {
            const tickAngle = startAngle + (totalAngle * (i / 10));
            const outerR = radius + 18;
            const innerR = radius + 14;
            const x1 = cx + Math.cos(tickAngle) * innerR;
            const y1 = cy + Math.sin(tickAngle) * innerR;
            const x2 = cx + Math.cos(tickAngle) * outerR;
            const y2 = cy + Math.sin(tickAngle) * outerR;

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = i % 5 === 0 ? 2 : 1;
            ctx.stroke();
        }
    }

    function updateGaugeColor(selector, percent) {
        const el = $(selector);
        if (percent >= 80) {
            el.style.background = 'linear-gradient(135deg, #ff4466, #ff0044)';
        } else if (percent >= 60) {
            el.style.background = 'linear-gradient(135deg, #ffaa00, #ff8800)';
        } else {
            el.style.background = 'linear-gradient(135deg, #00ff88, #00d4ff)';
        }
        el.style.webkitBackgroundClip = 'text';
        el.style.backgroundClip = 'text';
        el.style.webkitTextFillColor = 'transparent';
    }

    // ========== History Chart ==========
    let historyCanvas, historyCtx;

    async function updateHistoryChart(range) {
        if (!range) {
            const activeBtn = $('.range-btn.active');
            range = activeBtn ? activeBtn.dataset.range : '1h';
        }

        try {
            const { data, events } = await window.api.getHistory(range);
            historyData = data;
            historyEvents = events;
            drawHistoryChart();
        } catch (e) { }
    }

    function drawHistoryChart() {
        if (!historyCanvas) {
            historyCanvas = $('#historyChart');
            historyCtx = historyCanvas.getContext('2d');
        }

        const dpr = window.devicePixelRatio || 1;
        const rect = historyCanvas.parentElement.getBoundingClientRect();
        historyCanvas.width = rect.width * dpr;
        historyCanvas.height = rect.height * dpr;
        historyCanvas.style.width = rect.width + 'px';
        historyCanvas.style.height = rect.height + 'px';
        historyCtx.scale(dpr, dpr);

        const ctx = historyCtx;
        const w = rect.width;
        const h = rect.height;
        const padding = { top: 20, right: 20, bottom: 30, left: 45 };
        const chartW = w - padding.left - padding.right;
        const chartH = h - padding.top - padding.bottom;

        ctx.clearRect(0, 0, w, h);

        // No data message
        if (historyData.length < 2) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.font = '13px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('데이터 수집 중... (30초 간격으로 기록)', w / 2, h / 2);
            return;
        }

        // Grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (chartH / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            // Y axis labels
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`${100 - i * 25}%`, padding.left - 8, y + 4);
        }

        // Data line
        const timeRange = historyData[historyData.length - 1].time - historyData[0].time;

        ctx.beginPath();
        historyData.forEach((point, i) => {
            const x = padding.left + ((point.time - historyData[0].time) / timeRange) * chartW;
            const y = padding.top + ((100 - point.usage) / 100) * chartH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });

        // Line gradient
        const lineGrad = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
        lineGrad.addColorStop(0, '#ff4466');
        lineGrad.addColorStop(0.3, '#ffaa00');
        lineGrad.addColorStop(1, '#00ff88');
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Fill gradient under line
        const lastPoint = historyData[historyData.length - 1];
        const lastX = padding.left + ((lastPoint.time - historyData[0].time) / timeRange) * chartW;
        const lastY = padding.top + ((100 - lastPoint.usage) / 100) * chartH;
        ctx.lineTo(lastX, h - padding.bottom);
        ctx.lineTo(padding.left, h - padding.bottom);
        ctx.closePath();

        const fillGrad = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
        fillGrad.addColorStop(0, 'rgba(0, 255, 136, 0.15)');
        fillGrad.addColorStop(1, 'rgba(0, 255, 136, 0.01)');
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // Optimize event markers
        historyEvents.forEach(event => {
            const x = padding.left + ((event.time - historyData[0].time) / timeRange) * chartW;
            if (x >= padding.left && x <= w - padding.right) {
                ctx.beginPath();
                ctx.moveTo(x, padding.top);
                ctx.lineTo(x, h - padding.bottom);
                ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.stroke();
                ctx.setLineDash([]);

                // Marker dot
                ctx.beginPath();
                ctx.arc(x, padding.top + 8, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#00d4ff';
                ctx.fill();
            }
        });

        // Time labels
        const labelCount = 5;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        for (let i = 0; i <= labelCount; i++) {
            const t = historyData[0].time + (timeRange / labelCount) * i;
            const x = padding.left + (chartW / labelCount) * i;
            const date = new Date(t);
            ctx.fillText(`${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`, x, h - 8);
        }
    }

    // Chart range buttons
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('range-btn')) {
            $$('.range-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            updateHistoryChart(e.target.dataset.range);
        }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        drawHistoryChart();
    });

    // ========== Process Table ==========
    function setupProcessView() {
        // Search
        $('#processSearch').addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            renderProcessTable();
        });

        // Sort
        $$('.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (currentSort.key === key) {
                    currentSort.order = currentSort.order === 'desc' ? 'asc' : 'desc';
                } else {
                    currentSort.key = key;
                    currentSort.order = 'desc';
                }

                // Update UI
                $$('.process-table th').forEach(h => h.classList.remove('active-sort'));
                th.classList.add('active-sort');
                th.querySelector('.sort-arrow').textContent = currentSort.order === 'desc' ? '↓' : '↑';

                renderProcessTable();
            });
        });

        // Check all
        $('#checkAll').addEventListener('change', (e) => {
            const checked = e.target.checked;
            selectedPids.clear();
            if (checked) {
                getFilteredProcesses().forEach(p => selectedPids.add(p.pid));
            }
            renderProcessTable();
        });

        // Trim selected
        $('#btnTrimSelected').addEventListener('click', trimSelectedProcesses);
        $('#btnOptimizeAll2').addEventListener('click', runOptimizeAll);
    }

    function getFilteredProcesses() {
        let filtered = [...allProcesses];

        // Search filter
        if (searchQuery) {
            filtered = filtered.filter(p => p.name.toLowerCase().includes(searchQuery));
        }

        // Sort
        filtered.sort((a, b) => {
            let va, vb;
            switch (currentSort.key) {
                case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
                case 'pid': va = a.pid; vb = b.pid; break;
                case 'memory': va = a.memoryMB; vb = b.memoryMB; break;
                case 'cpu': va = a.cpu; vb = b.cpu; break;
                default: va = a.memoryMB; vb = b.memoryMB;
            }
            if (currentSort.key === 'name') {
                return currentSort.order === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
            }
            return currentSort.order === 'desc' ? vb - va : va - vb;
        });

        return filtered;
    }

    function renderProcessTable() {
        const tbody = $('#processTableBody');
        const processes = getFilteredProcesses();

        tbody.innerHTML = processes.map(p => {
            const statusClass = p.memoryMB >= 500 ? 'danger' : p.memoryMB >= 100 ? 'warn' : 'safe';
            const memClass = p.memoryMB >= 500 ? 'mem-danger' : p.memoryMB >= 100 ? 'mem-warn' : 'mem-safe';
            const isSelected = selectedPids.has(p.pid);

            return `
        <tr class="${isSelected ? 'selected' : ''}" data-pid="${p.pid}">
          <td class="col-check"><input type="checkbox" ${isSelected ? 'checked' : ''} data-pid="${p.pid}" /></td>
          <td class="col-status"><div class="process-status ${statusClass}"></div></td>
          <td class="col-name">${escapeHtml(p.name)}</td>
          <td class="col-pid" style="text-align:right">${p.pid}</td>
          <td class="col-memory ${memClass}" style="text-align:right">${p.memoryMB.toFixed(1)} MB</td>
          <td class="col-cpu" style="text-align:right">${p.cpu.toFixed(1)}s</td>
          <td class="col-actions"><button class="trim-btn" data-pid="${p.pid}">🧹 정리</button></td>
        </tr>
      `;
        }).join('');

        // Row checkbox handlers
        tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const pid = parseInt(e.target.dataset.pid);
                if (e.target.checked) {
                    selectedPids.add(pid);
                } else {
                    selectedPids.delete(pid);
                }
                renderProcessTable();
            });
        });

        // Individual trim buttons
        tbody.querySelectorAll('.trim-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const pid = parseInt(e.target.dataset.pid);
                e.target.disabled = true;
                e.target.textContent = '⏳';

                const result = await window.api.trimProcess(pid);

                if (result.success && result.freed > 0) {
                    showToast('success', '✅ 메모리 정리 완료',
                        `${result.freed.toFixed(1)} MB 해제됨 (${result.before.toFixed(1)} → ${result.after.toFixed(1)} MB)`);
                } else {
                    showToast('warning', '⚠️ 정리 실패', '해당 프로세스의 메모리를 정리할 수 없습니다.');
                }

                e.target.disabled = false;
                e.target.textContent = '🧹 정리';
            });
        });
    }

    async function trimSelectedProcesses() {
        if (selectedPids.size === 0) {
            showToast('warning', '⚠️ 선택 없음', '정리할 프로세스를 선택해주세요.');
            return;
        }

        showLoading(true);
        let totalFreed = 0;
        let count = 0;

        for (const pid of selectedPids) {
            const result = await window.api.trimProcess(pid);
            if (result.success && result.freed > 0) {
                totalFreed += result.freed;
                count++;
            }
        }

        showLoading(false);
        selectedPids.clear();
        renderProcessTable();

        showToast('success', '✅ 선택 프로세스 정리 완료',
            `${count}개 프로세스에서 ${totalFreed.toFixed(1)} MB 해제됨`);
    }

    // ========== Optimize All ==========
    async function runOptimizeAll() {
        showLoading(true);
        try {
            await window.api.optimizeAll();
        } catch (e) {
            showLoading(false);
            showToast('error', '❌ 최적화 실패', '오류가 발생했습니다.');
        }
    }

    function handleOptimizeComplete(report) {
        showLoading(false);

        if (report.totalFreed > 0) {
            let details = `${report.processedCount}개 프로세스에서 총 ${report.totalFreed.toFixed(1)} MB 해제\n`;
            report.results.slice(0, 3).forEach(r => {
                details += `• ${r.name}: ${r.freed.toFixed(1)} MB 절약\n`;
            });
            if (report.results.length > 3) {
                details += `... 외 ${report.results.length - 3}개`;
            }

            showToast('success', '⚡ 전체 최적화 완료', details);
        } else {
            showToast('warning', '⚡ 최적화 완료', '추가로 해제할 수 있는 메모리가 없습니다.');
        }

        updateHistoryChart();
    }

    // ========== Startup Program Management ==========
    let startupPrograms = [];
    let startupSearchQuery = '';
    let startupFilter = 'all';
    let startupTogglingIds = new Set();

    function setupStartupView() {
        // Search
        $('#startupSearch').addEventListener('input', (e) => {
            startupSearchQuery = e.target.value.toLowerCase();
            renderStartupList();
        });

        // Filter buttons
        $$('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                startupFilter = btn.dataset.filter;
                renderStartupList();
            });
        });

        // Refresh button
        $('#btnRefreshStartup').addEventListener('click', () => {
            loadStartupPrograms();
        });
    }

    async function loadStartupPrograms() {
        const listContainer = $('#startupList');
        listContainer.innerHTML = `
            <div class="startup-loading">
                <div class="loading-spinner small-spinner"></div>
                <span>시작 프로그램을 불러오는 중...</span>
            </div>
        `;

        try {
            startupPrograms = await window.api.getStartupPrograms();
            renderStartupList();
            updateStartupSummary();
        } catch (e) {
            listContainer.innerHTML = `
                <div class="startup-empty">
                    <span class="startup-empty-icon">⚠️</span>
                    <span>시작 프로그램 목록을 불러올 수 없습니다.</span>
                </div>
            `;
        }
    }

    function getFilteredStartups() {
        let filtered = [...startupPrograms];

        // Search filter
        if (startupSearchQuery) {
            filtered = filtered.filter(s =>
                s.name.toLowerCase().includes(startupSearchQuery) ||
                s.command.toLowerCase().includes(startupSearchQuery)
            );
        }

        // Type filter
        if (startupFilter !== 'all') {
            filtered = filtered.filter(s => {
                switch (startupFilter) {
                    case 'registry': return s.location === 'HKCU' || s.location === 'HKLM';
                    case 'folder': return s.location === 'StartupFolder';
                    case 'task': return s.location === 'TaskScheduler';
                    default: return true;
                }
            });
        }

        // Sort: enabled first, then by name
        filtered.sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        return filtered;
    }

    function getLocationBadge(location) {
        switch (location) {
            case 'HKCU': return '<span class="startup-location-badge badge-hkcu">👤 사용자</span>';
            case 'HKLM': return '<span class="startup-location-badge badge-hklm">🖥️ 시스템</span>';
            case 'StartupFolder': return '<span class="startup-location-badge badge-folder">📁 시작폴더</span>';
            case 'TaskScheduler': return '<span class="startup-location-badge badge-task">⏰ 스케줄러</span>';
            default: return '<span class="startup-location-badge">❓ 기타</span>';
        }
    }

    function getStartupIcon(name, type) {
        // Try to assign meaningful icons based on common program names
        const nameLower = name.toLowerCase();
        if (nameLower.includes('security') || nameLower.includes('defender') || nameLower.includes('antivirus')) return '🛡️';
        if (nameLower.includes('update') || nameLower.includes('updater')) return '🔄';
        if (nameLower.includes('discord')) return '💬';
        if (nameLower.includes('steam')) return '🎮';
        if (nameLower.includes('spotify')) return '🎵';
        if (nameLower.includes('dropbox') || nameLower.includes('drive') || nameLower.includes('onedrive') || nameLower.includes('cloud')) return '☁️';
        if (nameLower.includes('teams') || nameLower.includes('slack') || nameLower.includes('zoom')) return '📹';
        if (nameLower.includes('nvidia') || nameLower.includes('amd') || nameLower.includes('intel') || nameLower.includes('realtek')) return '🔧';
        if (nameLower.includes('chrome') || nameLower.includes('edge') || nameLower.includes('firefox') || nameLower.includes('browser')) return '🌐';
        if (nameLower.includes('backup')) return '💾';
        if (nameLower.includes('print') || nameLower.includes('printer')) return '🖨️';
        if (nameLower.includes('bluetooth')) return '📶';
        if (type === 'Task') return '📋';
        if (type === 'Shortcut') return '🔗';
        return '📦';
    }

    function renderStartupList() {
        const listContainer = $('#startupList');
        const filtered = getFilteredStartups();

        if (filtered.length === 0) {
            listContainer.innerHTML = `
                <div class="startup-empty">
                    <span class="startup-empty-icon">📭</span>
                    <span>${startupSearchQuery || startupFilter !== 'all' ? '검색 결과가 없습니다.' : '시작 프로그램이 없습니다.'}</span>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = filtered.map(s => {
            const icon = getStartupIcon(s.name, s.type);
            const badge = getLocationBadge(s.location);
            const isToggling = startupTogglingIds.has(s.id);
            const disabledClass = s.enabled ? '' : 'disabled-card';

            return `
                <div class="startup-card ${disabledClass}" data-id="${escapeHtml(s.id)}">
                    <div class="startup-icon-wrap">${icon}</div>
                    <div class="startup-info">
                        <div class="startup-name">${escapeHtml(s.name)}</div>
                        <div class="startup-command" title="${escapeHtml(s.command)}">${escapeHtml(s.command)}</div>
                    </div>
                    <div class="startup-meta">
                        ${badge}
                        <label class="startup-toggle" title="${s.enabled ? '비활성화' : '활성화'}">
                            <input type="checkbox" data-startup-id="${escapeHtml(s.id)}" 
                                   ${s.enabled ? 'checked' : ''} 
                                   ${isToggling ? 'disabled' : ''} />
                            <span class="toggle-track"></span>
                        </label>
                    </div>
                </div>
            `;
        }).join('');

        // Toggle event handlers
        listContainer.querySelectorAll('.startup-toggle input').forEach(toggle => {
            toggle.addEventListener('change', async (e) => {
                const id = e.target.dataset.startupId;
                const enable = e.target.checked;
                await handleStartupToggle(id, enable);
            });
        });

        updateStartupSummary();
    }

    async function handleStartupToggle(id, enable) {
        startupTogglingIds.add(id);
        renderStartupList();

        try {
            const result = await window.api.toggleStartup(id, enable);

            if (result.success) {
                // Update local data
                const item = startupPrograms.find(s => s.id === id);
                if (item) {
                    item.enabled = enable;
                }
                showToast('success', enable ? '✅ 활성화 완료' : '🚫 비활성화 완료', result.message);
            } else {
                showToast('error', '❌ 변경 실패', result.message);
                // Reload to get accurate state
                await loadStartupPrograms();
            }
        } catch (e) {
            showToast('error', '❌ 오류 발생', '시작 프로그램 상태를 변경할 수 없습니다.');
            await loadStartupPrograms();
        }

        startupTogglingIds.delete(id);
        renderStartupList();
    }

    function updateStartupSummary() {
        const total = startupPrograms.length;
        const enabled = startupPrograms.filter(s => s.enabled).length;
        const disabled = total - enabled;

        $('#startupTotalCount').textContent = total;
        $('#startupEnabledCount').textContent = enabled;
        $('#startupDisabledCount').textContent = disabled;

        // Impact level
        let impact;
        if (enabled <= 5) impact = '낮음';
        else if (enabled <= 10) impact = '보통';
        else if (enabled <= 15) impact = '높음';
        else impact = '매우 높음';
        $('#startupImpact').textContent = impact;
    }

    // ========== Settings ==========
    function setupSettings() {
        // Range sliders live update
        $('#settThreshold').addEventListener('input', (e) => {
            $('#settThresholdValue').textContent = e.target.value + '%';
        });
        $('#settAlertThreshold').addEventListener('input', (e) => {
            $('#settAlertThresholdValue').textContent = e.target.value + '%';
        });

        // Save
        $('#btnSaveSettings').addEventListener('click', async () => {
            const newSettings = {
                autoOptimize: $('#settAutoOptimize').checked,
                memoryThreshold: parseInt($('#settThreshold').value),
                checkInterval: parseInt($('#settInterval').value),
                minProcessSize: parseInt($('#settMinSize').value),
                cooldown: parseInt($('#settCooldown').value),
                alertThreshold: parseInt($('#settAlertThreshold').value),
                alertTray: $('#settAlertTray').checked,
                alertSound: $('#settAlertSound').checked,
                blacklist: currentSettings.blacklist
            };

            currentSettings = await window.api.saveSettings(newSettings);
            showToast('success', '💾 설정 저장 완료', '설정이 저장되었습니다.');
        });

        // Reset
        $('#btnResetSettings').addEventListener('click', async () => {
            const defaultSettings = {
                autoOptimize: false,
                memoryThreshold: 80,
                checkInterval: 30,
                minProcessSize: 100,
                cooldown: 5,
                alertThreshold: 70,
                alertTray: true,
                alertSound: true,
                blacklist: [
                    'System', 'smss.exe', 'csrss.exe', 'wininit.exe',
                    'services.exe', 'lsass.exe', 'svchost.exe',
                    'explorer.exe', 'dwm.exe', 'sihost.exe',
                    'SecurityHealthService.exe', 'Memory Optimizer'
                ]
            };
            currentSettings = await window.api.saveSettings(defaultSettings);
            applySettingsToUI(currentSettings);
            showToast('success', '↩ 설정 초기화', '기본 설정으로 복원되었습니다.');
        });

        // Blacklist add
        $('#btnAddBlacklist').addEventListener('click', () => {
            const input = $('#blacklistInput');
            const name = input.value.trim();
            if (name && !currentSettings.blacklist.includes(name)) {
                currentSettings.blacklist.push(name);
                renderBlacklist();
                input.value = '';
            }
        });

        $('#blacklistInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                $('#btnAddBlacklist').click();
            }
        });
    }

    function applySettingsToUI(s) {
        $('#settAutoOptimize').checked = s.autoOptimize;
        $('#settThreshold').value = s.memoryThreshold;
        $('#settThresholdValue').textContent = s.memoryThreshold + '%';
        $('#settInterval').value = s.checkInterval;
        $('#settMinSize').value = s.minProcessSize;
        $('#settCooldown').value = s.cooldown;
        $('#settAlertThreshold').value = s.alertThreshold;
        $('#settAlertThresholdValue').textContent = s.alertThreshold + '%';
        $('#settAlertTray').checked = s.alertTray;
        $('#settAlertSound').checked = s.alertSound;
        renderBlacklist();
    }

    function renderBlacklist() {
        const container = $('#blacklistContainer');
        container.innerHTML = currentSettings.blacklist.map((name, i) => `
      <div class="blacklist-tag">
        <span>${escapeHtml(name)}</span>
        <span class="remove-tag" data-index="${i}">✕</span>
      </div>
    `).join('');

        container.querySelectorAll('.remove-tag').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index);
                currentSettings.blacklist.splice(idx, 1);
                renderBlacklist();
            });
        });
    }

    // ========== Toast Notification ==========
    function showToast(type, title, body) {
        const container = $('#toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-body">${escapeHtml(body)}</div>
    `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // ========== Loading Overlay ==========
    function showLoading(show) {
        const overlay = $('#loadingOverlay');
        if (show) {
            overlay.classList.add('active');
        } else {
            overlay.classList.remove('active');
        }
    }

    // ========== Utility ==========
    function formatBytes(bytes) {
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return gb.toFixed(1) + ' GB';
        const mb = bytes / (1024 * 1024);
        return mb.toFixed(0) + ' MB';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ========== Start ==========
    document.addEventListener('DOMContentLoaded', init);
})();

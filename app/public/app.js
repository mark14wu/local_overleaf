(() => {
  let currentProject = null;
  let currentFile = null;
  let currentDir = null;
  let editor = null;
  let saveTimer = null;
  let currentFileMtime = null;
  let isSaving = false;
  let mtimePoller = null;

  // PDF.js state
  let pdfDoc = null;
  let pdfPages = []; // { canvas, wrapper, page }
  let pdfScale = 1.5;
  let pdfTotalPages = 0;

  const $ = (sel) => document.querySelector(sel);
  const projectSelect = $('#project-select');
  const fileTree = $('#file-tree');
  const btnCompile = $('#btn-compile');
  const btnDownload = $('#btn-download');
  const statusEl = $('#status');
  const logContent = $('#log-content');
  const btnToggleLog = $('#btn-toggle-log');
  const pdfContainer = $('#pdf-container');
  const pdfPageInput = $('#pdf-page-input');
  const pdfTotalPagesEl = $('#pdf-total-pages');
  const zoomSelect = $('#zoom-select');
  const compilerSelect = $('#compiler-select');
  const sidePanel = $('#side-panel');

  // Configure PDF.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // --- Editor Setup ---
  editor = CodeMirror.fromTextArea($('#editor'), {
    mode: 'stex',
    theme: 'monokai',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    extraKeys: {
      'Cmd-/': 'toggleComment',
      'Ctrl-/': 'toggleComment',
    },
  });

  editor.on('change', () => {
    if (!currentFile) return;
    if (!isTextFile(currentFile)) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentFile, 1500);
    statusEl.textContent = 'Modified';
  });

  // --- Key Bindings ---
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideFileTreeContextMenu();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      compile();
    }
    // Forward sync: Ctrl+Shift+Enter
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      forwardSync();
    }
  });

  // Dismiss file-tree context menu on outside click / scroll / resize.
  document.addEventListener('mousedown', (e) => {
    const menu = $('#file-tree-context-menu');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) {
      hideFileTreeContextMenu();
    }
  });
  window.addEventListener('resize', hideFileTreeContextMenu);
  document.addEventListener('scroll', hideFileTreeContextMenu, true);
  document.addEventListener('contextmenu', (e) => {
    // Suppress the browser menu for any other right-click that bubbles out of the tree,
    // but only when our menu initiated the event chain. Fall-through otherwise.
    const menu = $('#file-tree-context-menu');
    if (menu && menu.style.display !== 'none') hideFileTreeContextMenu();
  });

  // --- Rail Toggle Logic ---
  document.querySelectorAll('.rail-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      if (btn.classList.contains('active')) {
        // Deactivate — hide side panel
        btn.classList.remove('active');
        sidePanel.classList.add('hidden');
      } else {
        // Activate this, deactivate others
        document.querySelectorAll('.rail-btn[data-panel]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sidePanel.classList.remove('hidden');

        // Show appropriate content
        if (panel === 'file-tree') {
          fileTree.style.display = '';
          $('#sidebar-toolbar').style.display = '';
        } else {
          // Placeholder for other panels
          fileTree.style.display = 'none';
          $('#sidebar-toolbar').style.display = 'none';
        }
      }
      editor.refresh();
    });
  });

  // --- Projects ---
  async function loadProjects() {
    const projects = await fetch('/api/projects').then(r => r.json());
    projectSelect.innerHTML = '';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      projectSelect.appendChild(opt);
    });
    if (projects.length > 0) {
      const saved = localStorage.getItem('lastProject');
      currentProject = (saved && projects.includes(saved)) ? saved : projects[0];
      localStorage.setItem('lastProject', currentProject);
      projectSelect.value = currentProject;
      await loadFileTree();
      await loadProjectSettings();
      compile();
    }
  }

  projectSelect.addEventListener('change', async () => {
    currentProject = projectSelect.value;
    localStorage.setItem('lastProject', currentProject);
    currentFile = null;
    currentFileMtime = null;
    editor.setValue('');
    pdfContainer.innerHTML = '';
    pdfDoc = null;
    pdfPages = [];
    await loadFileTree();
    await loadProjectSettings();
    compile();
  });

  // --- Project Settings ---
  async function loadProjectSettings() {
    if (!currentProject) return;
    try {
      const settings = await fetch(`/api/projects/${currentProject}/settings`).then(r => r.json());
      compilerSelect.value = settings.compiler || 'pdflatex';
    } catch {
      compilerSelect.value = 'pdflatex';
    }
  }

  compilerSelect.addEventListener('change', async () => {
    if (!currentProject) return;
    await fetch(`/api/projects/${currentProject}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiler: compilerSelect.value }),
    });
  });

  // --- File Tree ---
  async function loadFileTree() {
    const files = await fetch(`/api/projects/${currentProject}/files`).then(r => r.json());
    fileTree.innerHTML = '';
    renderTree(files, fileTree, 0);
    if (currentDir) restoreDirSelection(currentDir);
  }

  function selectDir(dirPath) {
    currentDir = dirPath;
    document.querySelectorAll('.tree-dir.active').forEach(e => e.classList.remove('active'));
    const el = fileTree.querySelector(`[data-dir-path="${CSS.escape(dirPath)}"]`);
    if (el) el.classList.add('active');
  }

  function showFileTreeContextMenu(x, y, dirPath) {
    const menu = $('#file-tree-context-menu');
    menu.innerHTML = '';
    const upload = document.createElement('div');
    upload.className = 'ctx-item';
    upload.innerHTML = '<span class="material-symbols">upload_file</span><span>Upload file</span>';
    upload.addEventListener('click', () => {
      hideFileTreeContextMenu();
      $('#file-upload-input').click();
    });
    menu.appendChild(upload);

    menu.style.display = 'block';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
  }

  function hideFileTreeContextMenu() {
    const menu = $('#file-tree-context-menu');
    if (menu) menu.style.display = 'none';
  }

  function restoreDirSelection(dirPath) {
    const parts = dirPath.split('/');
    let accum = '';
    for (const part of parts) {
      accum = accum ? `${accum}/${part}` : part;
      const el = fileTree.querySelector(`[data-dir-path="${CSS.escape(accum)}"]`);
      if (el) {
        el.classList.add('open');
        const toggle = el.querySelector(':scope > .tree-label .tree-toggle .material-symbols');
        if (toggle) toggle.textContent = 'keyboard_arrow_down';
      }
    }
    const target = fileTree.querySelector(`[data-dir-path="${CSS.escape(dirPath)}"]`);
    if (target) target.classList.add('active');
  }

  function renderTree(items, parent, depth) {
    items.forEach(item => {
      const div = document.createElement('div');
      if (item.type === 'dir') {
        div.className = 'tree-item tree-dir';
        div.dataset.dirPath = item.path;
        const label = document.createElement('div');
        label.className = 'tree-label';
        label.innerHTML = `<span class="tree-toggle"><span class="material-symbols">keyboard_arrow_right</span></span><span class="tree-icon"><span class="material-symbols">folder</span></span><span class="tree-name">${item.name}</span>`;
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          div.classList.toggle('open');
          const toggle = label.querySelector('.tree-toggle .material-symbols');
          toggle.textContent = div.classList.contains('open') ? 'keyboard_arrow_down' : 'keyboard_arrow_right';
          selectDir(item.path);
        });
        label.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectDir(item.path);
          showFileTreeContextMenu(e.pageX, e.pageY, item.path);
        });
        div.appendChild(label);
        const children = document.createElement('div');
        children.className = 'tree-children';
        div.appendChild(children);
        parent.appendChild(div);
        renderTree(item.children, children, depth + 1);
      } else {
        div.className = 'tree-item tree-file';
        div.dataset.path = item.path;
        const label = document.createElement('div');
        label.className = 'tree-label';
        label.innerHTML = `<span class="tree-icon"><span class="material-symbols">description</span></span><span class="tree-name">${item.name}</span>`;
        label.addEventListener('click', () => openFile(item.path, div));
        div.appendChild(label);
        parent.appendChild(div);
      }
    });
  }

  // --- File Operations ---
  const TEXT_EXTS = new Set([
    'tex', 'bib', 'sty', 'cls', 'txt', 'md', 'cfg', 'def', 'ltx', 'dtx',
    'ins', 'bst', 'log', 'aux', 'toc', 'csv', 'json', 'xml', 'yaml', 'yml',
    'toml', 'ini', 'sh', 'py', 'r', 'lua', 'gitignore', 'latexmkrc', 'bbl',
  ]);

  function extOf(filePath) {
    if (!filePath) return '';
    const dot = filePath.lastIndexOf('.');
    if (dot < 0 || dot < filePath.lastIndexOf('/')) return '';
    return filePath.slice(dot + 1).toLowerCase();
  }

  function isTextFile(filePath) {
    if (!filePath) return false;
    const ext = extOf(filePath);
    return ext === '' || TEXT_EXTS.has(ext);
  }

  function isPdfFile(filePath) {
    return !!filePath && filePath.toLowerCase().endsWith('.pdf');
  }

  function showPdfFilePreview(filePath) {
    clearTimeout(saveTimer);
    const wrapper = editor.getWrapperElement();
    wrapper.style.display = 'none';
    const preview = $('#pdf-file-preview');
    const frame = $('#pdf-file-preview-frame');
    const url = `/api/projects/${encodeURIComponent(currentProject)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}`;
    frame.src = url;
    preview.style.display = 'flex';
  }

  function hidePdfFilePreview() {
    const preview = $('#pdf-file-preview');
    const frame = $('#pdf-file-preview-frame');
    if (preview.style.display !== 'none') {
      frame.src = 'about:blank';
      preview.style.display = 'none';
    }
    const wrapper = editor.getWrapperElement();
    if (wrapper.style.display === 'none') {
      wrapper.style.display = '';
      editor.refresh();
    }
  }

  async function openFile(filePath, el) {
    if (currentFile && isTextFile(currentFile) && editor.getValue()) {
      await saveCurrentFile();
    }
    clearTimeout(saveTimer);

    document.querySelectorAll('.tree-file.active').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.tree-dir.active').forEach(e => e.classList.remove('active'));
    if (el) el.classList.add('active');

    currentFile = filePath;
    currentDir = null;

    const ext = extOf(filePath);

    if (ext === 'pdf') {
      currentFileMtime = null;
      dismissExternalChangeBanner();
      showPdfFilePreview(filePath);
      statusEl.textContent = 'PDF (read-only)';
      return;
    }

    hidePdfFilePreview();

    if (!isTextFile(filePath)) {
      currentFileMtime = null;
      editor.setValue(`[Binary file: ${filePath}]`);
      statusEl.textContent = 'Binary file (read-only)';
      return;
    }

    try {
      const res = await fetch(`/api/projects/${currentProject}/files/${filePath}`);
      const text = await res.text();
      const mtimeHeader = res.headers.get('X-File-Mtime');
      currentFileMtime = mtimeHeader ? mtimeHeader : null;
      editor.setValue(text);
      editor.clearHistory();
      statusEl.textContent = 'Loaded';
      dismissExternalChangeBanner();

      if (ext === 'bib') {
        editor.setOption('mode', 'stex');
      } else if (['json', 'yaml', 'yml'].includes(ext)) {
        editor.setOption('mode', 'text/plain');
      } else {
        editor.setOption('mode', 'stex');
      }
    } catch (err) {
      statusEl.textContent = 'Error loading file';
    }
  }

  // Open file by path (for synctex) and scroll to line
  async function openFileAndGoToLine(filePath, line) {
    const treeEl = document.querySelector(`.tree-file[data-path="${filePath}"]`);
    await openFile(filePath, treeEl);
    setTimeout(() => {
      const lineIdx = Math.max(0, line - 1);
      editor.setCursor(lineIdx, 0);
      editor.scrollIntoView({ line: lineIdx, ch: 0 }, 100);
      editor.addLineClass(lineIdx, 'background', 'synctex-editor-highlight');
      setTimeout(() => {
        editor.removeLineClass(lineIdx, 'background', 'synctex-editor-highlight');
      }, 1500);
    }, 100);
  }

  async function saveCurrentFile() {
    if (!currentFile || !currentProject) return 'skipped';
    if (!isTextFile(currentFile)) return 'skipped';
    clearTimeout(saveTimer);
    isSaving = true;
    try {
      const headers = { 'Content-Type': 'text/plain' };
      if (currentFileMtime) {
        headers['X-Expected-Mtime'] = currentFileMtime;
      }
      const res = await fetch(`/api/projects/${currentProject}/files/${currentFile}`, {
        method: 'PUT',
        headers,
        body: editor.getValue(),
      });
      if (res.status === 409) {
        const data = await res.json();
        showConflictModal(data.diskContent, data.diskMtime);
        return 'conflict';
      }
      const data = await res.json();
      if (data.mtime) {
        currentFileMtime = String(data.mtime);
      }
      statusEl.textContent = 'Saved';
      dismissExternalChangeBanner();
      return 'saved';
    } catch (err) {
      statusEl.textContent = 'Save failed';
      return 'skipped';
    } finally {
      isSaving = false;
    }
  }

  // --- Conflict Modal ---
  function showConflictModal(diskContent, diskMtime) {
    const modal = $('#conflict-modal');
    modal.style.display = 'flex';
    modal._diskContent = diskContent;
    modal._diskMtime = diskMtime;
  }

  function hideConflictModal() {
    $('#conflict-modal').style.display = 'none';
  }

  // Reload from disk
  function conflictReload() {
    const modal = $('#conflict-modal');
    editor.setValue(modal._diskContent);
    editor.clearHistory();
    currentFileMtime = String(modal._diskMtime);
    statusEl.textContent = 'Reloaded from disk';
    dismissExternalChangeBanner();
    hideConflictModal();
  }

  // Overwrite disk with editor content
  async function conflictOverwrite() {
    hideConflictModal();
    const modal = $('#conflict-modal');
    // Save without mtime check (force overwrite)
    currentFileMtime = null;
    await saveCurrentFile();
  }

  // --- External Change Banner ---
  function showExternalChangeBanner() {
    const banner = $('#external-change-banner');
    if (banner) banner.style.display = 'flex';
  }

  function dismissExternalChangeBanner() {
    const banner = $('#external-change-banner');
    if (banner) banner.style.display = 'none';
  }

  async function bannerReload() {
    if (!currentFile || !currentProject) return;
    try {
      const res = await fetch(`/api/projects/${currentProject}/files/${currentFile}`);
      const text = await res.text();
      const mtimeHeader = res.headers.get('X-File-Mtime');
      currentFileMtime = mtimeHeader ? mtimeHeader : null;
      editor.setValue(text);
      editor.clearHistory();
      statusEl.textContent = 'Reloaded from disk';
      dismissExternalChangeBanner();
    } catch (err) {
      statusEl.textContent = 'Reload failed';
    }
  }

  // --- Mtime Polling ---
  function startMtimePolling() {
    if (mtimePoller) clearInterval(mtimePoller);
    mtimePoller = setInterval(async () => {
      if (!currentFile || !currentProject || !currentFileMtime || isSaving) return;
      try {
        const res = await fetch(`/api/projects/${currentProject}/files-mtime/${currentFile}`);
        if (!res.ok) return;
        const data = await res.json();
        if (String(data.mtime) !== currentFileMtime) {
          showExternalChangeBanner();
        }
      } catch (e) {
        // ignore polling errors
      }
    }, 5000);
  }

  startMtimePolling();

  // --- PDF.js Rendering ---
  async function loadPdf() {
    const url = `/api/projects/${currentProject}/pdf?t=${Date.now()}`;
    try {
      // Save scroll position before clearing
      let savedPage = null;
      let savedOffset = 0;
      if (pdfPages.length > 0) {
        savedPage = getCurrentVisiblePage();
        const pageEntry = pdfPages.find(p => p.pageNum === savedPage);
        if (pageEntry) {
          savedOffset = pdfContainer.scrollTop - pageEntry.wrapper.offsetTop;
        }
      }

      pdfDoc = await pdfjsLib.getDocument(url).promise;
      pdfTotalPages = pdfDoc.numPages;
      pdfContainer.innerHTML = '';
      pdfPages = [];

      for (let i = 1; i <= pdfTotalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: pdfScale });

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page-wrapper';
        wrapper.dataset.page = i;

        const canvas = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
        wrapper.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Double-click for reverse synctex
        canvas.addEventListener('dblclick', (e) => handlePdfDoubleClick(e, i, canvas));

        pdfContainer.appendChild(wrapper);
        pdfPages.push({ canvas, wrapper, page, pageNum: i });
      }

      // Restore scroll position after rendering
      if (savedPage !== null) {
        const targetPage = Math.min(savedPage, pdfTotalPages);
        const targetEntry = pdfPages.find(p => p.pageNum === targetPage);
        if (targetEntry) {
          pdfContainer.scrollTop = targetEntry.wrapper.offsetTop + savedOffset;
        }
      }

      updatePageInfo();
    } catch (err) {
      pdfContainer.innerHTML = `<div style="color:var(--content-secondary);padding:40px;text-align:center">No PDF available. Click Recompile.</div>`;
    }
  }

  function updatePageInfo() {
    const currentPage = getCurrentVisiblePage();
    pdfPageInput.value = currentPage;
    pdfTotalPagesEl.textContent = pdfTotalPages;
    updateZoomSelect();
  }

  function updateZoomSelect() {
    const pct = Math.round(pdfScale / 1.5 * 100);
    // Try to match a preset
    let matched = false;
    for (const opt of zoomSelect.options) {
      if (opt.value !== 'fit' && Math.round(parseFloat(opt.value) / 1.5 * 100) === pct) {
        zoomSelect.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // If no match, set to closest or leave
      zoomSelect.value = String(pdfScale);
    }
  }

  function getCurrentVisiblePage() {
    const containerRect = pdfContainer.getBoundingClientRect();
    const containerMiddle = containerRect.top + containerRect.height / 2;
    let closest = 1;
    let closestDist = Infinity;
    for (const p of pdfPages) {
      const rect = p.wrapper.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const dist = Math.abs(mid - containerMiddle);
      if (dist < closestDist) {
        closestDist = dist;
        closest = p.pageNum;
      }
    }
    return closest;
  }

  pdfContainer.addEventListener('scroll', () => updatePageInfo());

  // Page input navigation
  pdfPageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const page = parseInt(pdfPageInput.value);
      if (page >= 1 && page <= pdfTotalPages && pdfPages[page - 1]) {
        pdfPages[page - 1].wrapper.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });

  // Zoom
  async function setZoom(newScale) {
    pdfScale = Math.max(0.5, Math.min(4.0, newScale));
    if (!pdfDoc) return;

    // Record current visible page and its relative offset in the viewport
    const currentPage = getCurrentVisiblePage();
    const pageEntry = pdfPages[currentPage - 1];
    const containerRect = pdfContainer.getBoundingClientRect();
    const pageRect = pageEntry.wrapper.getBoundingClientRect();
    const offsetRatio = (containerRect.top - pageRect.top) / pageRect.height;

    // Re-render all pages at the new scale with HiDPI support
    const dpr = window.devicePixelRatio || 1;
    for (const p of pdfPages) {
      const viewport = p.page.getViewport({ scale: pdfScale });
      p.canvas.width = Math.floor(viewport.width * dpr);
      p.canvas.height = Math.floor(viewport.height * dpr);
      p.canvas.style.width = viewport.width + 'px';
      p.canvas.style.height = viewport.height + 'px';
      const ctx = p.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await p.page.render({ canvasContext: ctx, viewport }).promise;
    }

    // Restore scroll position to keep the same page at the same relative offset
    const newContainerRect = pdfContainer.getBoundingClientRect();
    const newPageRect = pageEntry.wrapper.getBoundingClientRect();
    const targetScrollTop = pdfContainer.scrollTop
      + (newPageRect.top - newContainerRect.top)
      + offsetRatio * newPageRect.height;
    pdfContainer.scrollTop = targetScrollTop;

    updatePageInfo();
  }

  function fitToWidth() {
    if (!pdfPages.length || !pdfDoc) return;
    const containerWidth = pdfContainer.clientWidth - 32;
    const vp = pdfPages[0].page.getViewport({ scale: 1 });
    const fitScale = containerWidth / vp.width;
    setZoom(fitScale);
  }

  $('#btn-zoom-in').addEventListener('click', () => setZoom(pdfScale + 0.15));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(pdfScale - 0.15));

  zoomSelect.addEventListener('change', () => {
    const val = zoomSelect.value;
    if (val === 'fit') {
      fitToWidth();
    } else {
      setZoom(parseFloat(val));
    }
  });

  // --- Pinch-to-zoom on trackpad (Ctrl+wheel / pinch gesture) ---
  // Follows Overleaf's approach: direct scale on each event, mouse-centered zoom,
  // anti-momentum-scroll guard, and lightweight 5ms throttle.
  let isZooming = false;
  let isScrolling = false;
  let scrollTimeout = null;

  pdfContainer.addEventListener('wheel', (e) => {
    if (e.metaKey || e.ctrlKey) {
      // Anti-momentum-scroll guard: if user is scrolling and presses Ctrl, ignore
      if (isScrolling) return;
      e.preventDefault();

      // 5ms throttle to avoid excessive re-renders on high-refresh trackpads
      if (isZooming) return;
      isZooming = true;
      setTimeout(() => { isZooming = false; }, 5);

      // Calculate scale factor, capped at 1.2x per event
      const SCALE_FACTOR_DIVISOR = 20;
      const MAX_SCALE_FACTOR = 1.2;
      const scaleFactorMagnitude = Math.min(
        1 + Math.abs(e.deltaY) / SCALE_FACTOR_DIVISOR,
        MAX_SCALE_FACTOR
      );
      const exactScaleFactor = e.deltaY > 0
        ? 1 / scaleFactorMagnitude
        : scaleFactorMagnitude;

      const newScale = Math.max(0.5, Math.min(4.0, pdfScale * exactScaleFactor));
      if (newScale === pdfScale) return;

      // Mouse-centered zoom: adjust scroll so content under cursor stays put
      const containerRect = pdfContainer.getBoundingClientRect();
      const mouseX = e.clientX - containerRect.left;
      const mouseY = e.clientY - containerRect.top;
      const realFactor = newScale / pdfScale;

      setZoom(newScale);

      pdfContainer.scrollBy({
        left: mouseX * realFactor - mouseX,
        top: mouseY * realFactor - mouseY,
        behavior: 'instant',
      });
    } else {
      // Track scrolling state: clear after 100ms of no wheel events
      isScrolling = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => { isScrolling = false; }, 100);
    }
  }, { passive: false });

  // --- SyncTeX: PDF → Code (Reverse Sync) ---
  async function handlePdfDoubleClick(e, pageNum, canvas) {
    if (!currentProject) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const pdfH = x / pdfScale;
    const pdfV = y / pdfScale;

    try {
      const res = await fetch(
        `/api/projects/${currentProject}/sync/pdf?page=${pageNum}&h=${pdfH.toFixed(2)}&v=${pdfV.toFixed(2)}`
      );
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error || 'SyncTeX failed');
        return;
      }
      if (data.length > 0) {
        const { file, line } = data[0];
        openFileAndGoToLine(file, line);
      } else {
        setStatus('SyncTeX: no matching source location found');
      }
    } catch (err) {
      console.error('SyncTeX reverse sync failed:', err);
      setStatus('SyncTeX reverse sync failed');
    }
  }

  // --- SyncTeX: Code → PDF (Forward Sync) ---
  async function forwardSync() {
    if (!currentProject || !currentFile) return;

    const cursor = editor.getCursor();
    const line = cursor.line + 1;
    const col = cursor.ch;

    try {
      const res = await fetch(
        `/api/projects/${currentProject}/sync/code?file=${encodeURIComponent(currentFile)}&line=${line}&column=${col}`
      );
      const data = await res.json();
      if (data.length > 0) {
        const target = data[0];
        const pageIdx = target.page - 1;
        if (pageIdx >= 0 && pageIdx < pdfPages.length) {
          pdfPages[pageIdx].wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });

          setTimeout(() => {
            const highlight = document.createElement('div');
            highlight.className = 'synctex-pdf-highlight';
            const scale = pdfScale;
            highlight.style.left = (target.h * scale) + 'px';
            highlight.style.top = (target.v * scale - target.height * scale) + 'px';
            highlight.style.width = Math.max(target.width * scale, 200) + 'px';
            highlight.style.height = Math.max(target.height * scale, 16) + 'px';
            pdfPages[pageIdx].wrapper.appendChild(highlight);
            setTimeout(() => highlight.remove(), 2000);
          }, 400);
        }
      }
    } catch (err) {
      console.error('SyncTeX forward sync failed:', err);
    }
  }

  // SyncTeX buttons
  $('#btn-sync-to-pdf').addEventListener('click', forwardSync);
  $('#btn-sync-to-code').addEventListener('click', () => {
    // Reverse sync uses double-click on PDF; this button scrolls to last position
    if (pdfPages.length > 0) {
      const cur = getCurrentVisiblePage();
      statusEl.textContent = 'Double-click on PDF to jump to code';
    }
  });

  // --- Compile ---
  async function compile() {
    if (!currentProject) return;
    if (btnCompile.classList.contains('compiling')) return;

    await saveCurrentFile();

    btnCompile.classList.add('compiling');
    btnCompile.innerHTML = '<span class="material-symbols">play_arrow</span> Compiling...';
    statusEl.textContent = 'Compiling...';

    try {
      const res = await fetch(`/api/projects/${currentProject}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      logContent.textContent = data.log || 'No output';
      parseLogBadges(data.log || '');

      if (data.success) {
        statusEl.textContent = data.warnings ? 'Compiled with warnings' : 'Compiled successfully';
        await loadPdf();
      } else {
        statusEl.textContent = 'Compilation failed';
        logContent.classList.add('open');
      }
    } catch (err) {
      statusEl.textContent = 'Compile error';
      logContent.textContent = err.message;
      logContent.classList.add('open');
    } finally {
      btnCompile.classList.remove('compiling');
      btnCompile.innerHTML = '<span class="material-symbols">play_arrow</span> Recompile';
    }
  }

  btnCompile.addEventListener('click', compile);

  // --- Log Parsing ---
  function parseLogBadges(log) {
    const errorCount = (log.match(/^!/gm) || []).length;
    const warnCount = (log.match(/LaTeX Warning/gi) || []).length;

    const errBadge = $('#log-errors');
    const warnBadge = $('#log-warnings');

    if (errorCount > 0) {
      errBadge.textContent = errorCount + ' error' + (errorCount !== 1 ? 's' : '');
      errBadge.style.display = 'inline';
    } else {
      errBadge.style.display = 'none';
    }

    if (warnCount > 0) {
      warnBadge.textContent = warnCount + ' warning' + (warnCount !== 1 ? 's' : '');
      warnBadge.style.display = 'inline';
    } else {
      warnBadge.style.display = 'none';
    }
  }

  // --- Download ---
  btnDownload.addEventListener('click', () => {
    if (!currentProject) return;
    const a = document.createElement('a');
    a.href = `/api/projects/${currentProject}/pdf`;
    a.download = `${currentProject}.pdf`;
    a.click();
  });

  // --- Log Toggle ---
  btnToggleLog.addEventListener('click', (e) => {
    e.stopPropagation();
    logContent.classList.toggle('open');
  });
  $('#log-header').addEventListener('click', () => logContent.classList.toggle('open'));
  $('#btn-close-log').addEventListener('click', (e) => {
    e.stopPropagation();
    logContent.classList.remove('open');
  });

  // --- New File / New Folder ---
  $('#btn-new-file').addEventListener('click', async () => {
    if (!currentProject) return;
    const name = prompt('New file name (e.g., chapter2.tex):');
    if (!name) return;
    await fetch(`/api/projects/${currentProject}/files/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    });
    loadFileTree();
  });

  $('#btn-new-folder').addEventListener('click', async () => {
    if (!currentProject) return;
    const name = prompt('New folder name:');
    if (!name) return;
    await fetch(`/api/projects/${currentProject}/files/${name}/.gitkeep`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    });
    loadFileTree();
  });

  // --- Upload File ---
  $('#btn-upload-file').addEventListener('click', () => {
    if (!currentProject) return;
    $('#file-upload-input').click();
  });

  $('#file-upload-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!currentProject || files.length === 0) return;

    const folder = currentDir
      ? currentDir
      : (currentFile ? currentFile.split('/').slice(0, -1).join('/') : '');
    const btn = $('#btn-upload-file');
    btn.disabled = true;
    try {
      for (const file of files) {
        const dest = folder ? `${folder}/${file.name}` : file.name;
        const head = await fetch(`/api/projects/${currentProject}/files-mtime/${dest}`);
        if (head.ok && !confirm(`"${dest}" already exists. Overwrite?`)) continue;
        const buf = await file.arrayBuffer();
        const res = await fetch(`/api/projects/${currentProject}/files/${dest}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        if (!res.ok) {
          alert(`Upload failed for ${file.name}: ${res.status}`);
          break;
        }
      }
      await loadFileTree();
    } finally {
      btn.disabled = false;
    }
  });

  // --- Splitters ---
  function initSplitter(splitterId, leftId) {
    const splitter = $(splitterId);
    let startX, leftWidth;

    splitter.addEventListener('mousedown', (e) => {
      const leftEl = $(leftId);
      startX = e.clientX;
      leftWidth = leftEl.getBoundingClientRect().width;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    function onMove(e) {
      const dx = e.clientX - startX;
      $(leftId).style.width = (leftWidth + dx) + 'px';
      $(leftId).style.flex = 'none';
      editor.refresh();
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }

  initSplitter('#splitter-left', '#side-panel');
  initSplitter('#splitter-right', '#editor-pane');

  // --- Conflict Modal & Banner Wiring ---
  $('#btn-conflict-reload').addEventListener('click', conflictReload);
  $('#btn-conflict-overwrite').addEventListener('click', conflictOverwrite);
  $('#external-change-banner').__reload = bannerReload;

  // --- Init ---
  loadProjects();
})();

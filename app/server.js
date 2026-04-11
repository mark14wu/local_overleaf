const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = 3000;
const PROJECTS_DIR = path.resolve(__dirname, '..', 'projects');

// Per-project compile locks
const compileLocks = new Map();

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Compiler config ---
const COMPILER_FLAGS = {
  pdflatex: '-pdf',
  latex: '-pdfdvi',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
};
const VALID_COMPILERS = Object.keys(COMPILER_FLAGS);

// --- Per-project settings ---
function getProjectSettings(projectDir) {
  const settingsPath = path.join(projectDir, '.overleaf.json');
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { return {}; }
}

function saveProjectSettings(projectDir, settings) {
  fs.writeFileSync(path.join(projectDir, '.overleaf.json'), JSON.stringify(settings, null, 2));
}

// --- Helpers ---

function safePath(projectName, filePath) {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  const resolved = path.resolve(projectDir, filePath || '');
  if (!resolved.startsWith(projectDir)) return null;
  return resolved;
}

// LaTeX intermediate/output file extensions to hide from the file tree
const HIDDEN_EXTS = new Set([
  '.aux', '.log', '.fls', '.fdb_latexmk', '.bbl', '.blg',
  '.synctex.gz', '.out', '.toc', '.lof', '.lot', '.nav',
  '.snm', '.vrb', '.xdv', '.bcf', '.run.xml',
]);
// Only hidden at the project root (latexmk output dir) — assets in subfolders stay visible.
const ROOT_HIDDEN_EXTS = new Set(['.pdf']);

function isHiddenFile(name, isRoot) {
  if (name === '.overleaf.json') return true;
  for (const ext of HIDDEN_EXTS) {
    if (name.endsWith(ext)) return true;
  }
  if (isRoot) {
    for (const ext of ROOT_HIDDEN_EXTS) {
      if (name.endsWith(ext)) return true;
    }
  }
  return false;
}

function walkDir(dir, base, isRoot = true) {
  const entries = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const rel = path.join(base, ent.name);
    if (ent.isDirectory()) {
      entries.push({ name: ent.name, path: rel, type: 'dir', children: walkDir(path.join(dir, ent.name), rel, false) });
    } else {
      if (isHiddenFile(ent.name, isRoot)) continue;
      entries.push({ name: ent.name, path: rel, type: 'file' });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return entries;
}

// --- Routes ---

// List projects
app.get('/api/projects', (req, res) => {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
    res.json(dirs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File tree
app.get('/api/projects/:name/files', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  try {
    res.json(walkDir(projectDir, ''));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read file
app.get('/api/projects/:name/files/*filepath', (req, res) => {
  const fp = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
  const filePath = safePath(req.params.name, fp);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  res.set('X-File-Mtime', String(stat.mtimeMs));

  const ext = path.extname(filePath).toLowerCase();
  const textExts = ['.tex', '.bib', '.sty', '.cls', '.txt', '.md', '.cfg', '.def', '.ltx', '.dtx', '.ins', '.bbl', '.bst', '.log', '.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.vrb', '.pgf', '.tikz', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.sh', '.py', '.r', '.lua', '.gitignore', '.latexmkrc'];
  if (textExts.includes(ext) || ext === '') {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.type('text/plain').send(content);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    res.sendFile(filePath);
  }
});

// File mtime check (lightweight polling endpoint)
app.get('/api/projects/:name/files-mtime/*filepath', (req, res) => {
  const fp = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
  const filePath = safePath(req.params.name, fp);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  res.json({ mtime: stat.mtimeMs });
});

// Save file
app.put('/api/projects/:name/files/*filepath', (req, res) => {
  const fp = Array.isArray(req.params.filepath) ? req.params.filepath.join('/') : req.params.filepath;
  const filePath = safePath(req.params.name, fp);
  if (!filePath) return res.status(400).json({ error: 'Invalid path' });
  try {
    const expectedMtime = req.headers['x-expected-mtime'];
    if (expectedMtime && fs.existsSync(filePath)) {
      const currentStat = fs.statSync(filePath);
      if (String(currentStat.mtimeMs) !== expectedMtime) {
        const diskContent = fs.readFileSync(filePath, 'utf-8');
        return res.status(409).json({ conflict: true, diskContent, diskMtime: currentStat.mtimeMs });
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = req.body;
    const data = Buffer.isBuffer(body)
      ? body
      : (typeof body === 'string' ? body : JSON.stringify(body));
    fs.writeFileSync(filePath, data);
    const newStat = fs.statSync(filePath);
    res.json({ ok: true, mtime: newStat.mtimeMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Project settings
app.get('/api/projects/:name/settings', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  res.json(getProjectSettings(projectDir));
});

app.put('/api/projects/:name/settings', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  const settings = getProjectSettings(projectDir);
  if (req.body.compiler) {
    if (!VALID_COMPILERS.includes(req.body.compiler)) {
      return res.status(400).json({ error: `Invalid compiler. Must be one of: ${VALID_COMPILERS.join(', ')}` });
    }
    settings.compiler = req.body.compiler;
  }
  saveProjectSettings(projectDir, settings);
  res.json(settings);
});

// Compile
app.post('/api/projects/:name/compile', (req, res) => {
  const projectName = req.params.name;
  const projectDir = safePath(projectName, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  if (compileLocks.get(projectName)) {
    return res.status(409).json({ error: 'Compilation already in progress' });
  }
  compileLocks.set(projectName, true);

  // Find main .tex file
  const mainFile = req.body.mainFile || 'main.tex';

  const settings = getProjectSettings(projectDir);
  const compiler = settings.compiler || 'pdflatex';
  const compilerFlag = COMPILER_FLAGS[compiler] || '-pdf';

  const safeMainFile = mainFile.replace(/[^a-zA-Z0-9._-]/g, '');
  exec(`latexmk ${compilerFlag} -synctex=1 -f -interaction=nonstopmode "${safeMainFile}"`, {
    cwd: projectDir,
    timeout: 120000,
  }, (err, stdout, stderr) => {
    compileLocks.set(projectName, false);
    const log = stdout + '\n' + stderr;
    if (err) {
      // latexmk may return non-zero but still produce a PDF
      const pdfName = mainFile.replace(/\.tex$/, '.pdf');
      const pdfPath = path.join(projectDir, pdfName);
      if (fs.existsSync(pdfPath)) {
        return res.json({ success: true, warnings: true, log });
      }
      return res.json({ success: false, log });
    }
    res.json({ success: true, log });
  });
});

// Serve PDF
app.get('/api/projects/:name/pdf', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir) return res.status(400).json({ error: 'Invalid path' });

  const mainFile = (req.query.mainFile || 'main.tex').replace(/\.tex$/, '.pdf');
  const pdfPath = path.join(projectDir, mainFile);
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found. Compile first.' });
  res.sendFile(pdfPath);
});

// SyncTeX reverse sync: PDF → Code
app.get('/api/projects/:name/sync/pdf', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const { page, h, v } = req.query;
  if (!page || h == null || v == null) return res.status(400).json({ error: 'Missing page, h, or v' });

  const mainPdf = (req.query.mainFile || 'main.tex').replace(/\.tex$/, '.pdf');
  const synctexFile = path.join(projectDir, mainPdf.replace('.pdf', '.synctex.gz'));
  if (!fs.existsSync(synctexFile)) {
    return res.status(404).json({ error: 'SyncTeX data not found. Please recompile first.' });
  }
  const cmd = `synctex edit -o "${Number(page)}:${Number(h)}:${Number(v)}:${mainPdf}"`;
  exec(cmd, { cwd: projectDir, timeout: 10000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'synctex failed', detail: err.message });
    const results = [];
    const blocks = stdout.split('Output:');
    for (const block of blocks) {
      const inputMatch = block.match(/Input:(.+)/);
      const lineMatch = block.match(/Line:(\d+)/);
      const colMatch = block.match(/Column:(-?\d+)/);
      if (inputMatch && lineMatch) {
        let file = inputMatch[1].trim();
        // Make path relative to project dir
        if (path.isAbsolute(file)) {
          file = path.relative(projectDir, file);
        }
        results.push({
          file,
          line: parseInt(lineMatch[1], 10),
          column: Math.max(0, parseInt((colMatch && colMatch[1]) || '0', 10)),
        });
      }
    }
    res.json(results);
  });
});

// SyncTeX forward sync: Code → PDF
app.get('/api/projects/:name/sync/code', (req, res) => {
  const projectDir = safePath(req.params.name, '');
  if (!projectDir || !fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const { file, line, column } = req.query;
  if (!file || !line) return res.status(400).json({ error: 'Missing file or line' });

  const safeFile = file.replace(/[^a-zA-Z0-9._\-\/]/g, '');
  const mainPdf = (req.query.mainFile || 'main.tex').replace(/\.tex$/, '.pdf');
  const col = column || '0';
  const cmd = `synctex view -i "${Number(line)}:${Number(col)}:${safeFile}" -o "${mainPdf}"`;
  exec(cmd, { cwd: projectDir, timeout: 10000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'synctex failed', detail: err.message });
    const results = [];
    const blocks = stdout.split('Output:');
    for (const block of blocks) {
      const pageMatch = block.match(/Page:(\d+)/);
      const hMatch = block.match(/h:([\d.]+)/);
      const vMatch = block.match(/v:([\d.]+)/);
      const wMatch = block.match(/W:([\d.]+)/);
      const hgtMatch = block.match(/H:([\d.]+)/);
      if (pageMatch) {
        results.push({
          page: parseInt(pageMatch[1], 10),
          h: parseFloat((hMatch && hMatch[1]) || '0'),
          v: parseFloat((vMatch && vMatch[1]) || '0'),
          width: parseFloat((wMatch && wMatch[1]) || '0'),
          height: parseFloat((hgtMatch && hgtMatch[1]) || '0'),
        });
      }
    }
    res.json(results);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  // Start cloudflared tunnel and print public URL
  const cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let urlFound = false;
  const extractUrl = (data) => {
    if (urlFound) return;
    const match = data.toString().match(/https:\/\/[^\s|]+\.trycloudflare\.com/);
    if (match) {
      urlFound = true;
      console.log(`\nPublic URL: ${match[0]}\n`);
    }
  };
  cloudflared.stdout.on('data', extractUrl);
  cloudflared.stderr.on('data', extractUrl);
  cloudflared.on('error', (err) => {
    console.error('Failed to start cloudflared:', err.message);
  });
});

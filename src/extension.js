'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const core = require('./core');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const { createLicense } = require('./license');
const { createTrialAccess } = require('./trials');
const { createReach, withSurface } = require('./reach');
const EXT = 'zovo.zovo-code-coverage', PREFIX = 'codeCoverage';
const historyKey = 'codeCoverage.history';
let rating = { success() {}, failure() {} }, files = [], rootPath = '', reach = null, summaryPanel = null;
const TRIES_KEY = 'codeCoverage.proTries';
// Pro tools: id = key in the tries store and in the Explorer command codeCoverage.zovoPro.<id>.
const TOOLS = [
  { id: 'diff', title: 'Diff coverage against main', command: 'codeCoverage.diff' },
  { id: 'export', title: 'Export coverage report', command: 'codeCoverage.export' },
  { id: 'history', title: 'History and CI threshold', command: 'codeCoverage.history' }
];
const output = vscode.window.createOutputChannel('Code Coverage');
const missedMark = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorError.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
const hitMark = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
const branchMark = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1.5em' } });
function pct(n) { return `${(n || 0).toFixed(1)}%`; }
function root() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; }
async function loadReports() {
  rootPath = root(); if (!rootPath) { files = []; return files; }
  const cfg = vscode.workspace.getConfiguration(PREFIX), names = cfg.get('reportFiles', ['coverage/lcov.info', 'lcov.info', 'coverage.xml', 'jacoco.xml', 'clover.xml']);
  const found = await vscode.workspace.findFiles('**/{lcov.info,coverage.xml,jacoco.xml,clover.xml}', '**/{node_modules,.git}/**', 100);
  for (const name of names) {
    const pattern = `**/${path.basename(name)}`;
    const hits = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git}/**', 100);
    found.push(...hits);
  }
  const candidates = new Set(names.map(name => path.resolve(rootPath, name)));
  for (const uri of found) if (uri.fsPath.startsWith(rootPath + path.sep)) candidates.add(uri.fsPath);
  const reports = [], exists = p => { try { return require('node:fs').existsSync(p); } catch { return false; } };
  for (const abs of core.pickReports([...candidates].filter(exists))) {
    const name = path.relative(rootPath, abs);
    if (!abs.startsWith(rootPath + path.sep) && abs !== rootPath) continue;
    let data; try { data = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const ext = path.extname(name).toLowerCase(), format = /lcov|\.info$/.test(name.toLowerCase()) ? 'lcov' : ext === '.xml' ? detectXml(data) : '';
    if (!format) continue;
    try { reports.push(core.parseReport(data, format)); rating.success(vscode.Uri.file(abs)); } catch (e) { rating.failure(); output.appendLine(`Skipped ${name}: ${e.message}`); }
  }
  files = core.mergeReports(reports, rootPath, exists); return files;
}
function detectXml(xml) { return /<sourcefile\b|<report\b/.test(xml) ? 'jacoco' : /<file\b[^>]*\bname=/.test(xml) ? 'clover' : /<class\b[^>]*\bfilename=/.test(xml) ? 'cobertura' : ''; }
function mark(editor) {
  if (!editor || !vscode.workspace.getConfiguration(PREFIX).get('showLineMarks', true)) return;
  const f = files.find(x => path.normalize(x.absolute) === path.normalize(editor.document.uri.fsPath));
  if (!f) { editor.setDecorations(missedMark, []); editor.setDecorations(hitMark, []); editor.setDecorations(branchMark, []); return; }
  const missed = [], covered = [], branchByLine = new Map();
  for (const [n, count] of f.lines) { const r = new vscode.Range(n - 1, 0, n - 1, 0); (count > 0 ? covered : missed).push(r); }
  for (const [key, count] of f.branches) {
    const line = Number(String(key).split(':')[0]); if (!line || !Number.isFinite(count)) continue;
    const stat = branchByLine.get(line) || { hit: 0, total: 0 }; stat.total++; if (count > 0) stat.hit++; branchByLine.set(line, stat);
  }
  const lastLine = editor.document.lineCount;
  const branches = [...branchByLine].filter(([line]) => line <= lastLine).map(([line, stat]) => { const end = editor.document.lineAt(line - 1).range.end; return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: `branches ${stat.hit}/${stat.total}` } } }; });
  editor.setDecorations(missedMark, missed); editor.setDecorations(hitMark, covered); editor.setDecorations(branchMark, branches);
}
class CoverageTree {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(parent) {
    if (parent) return [];
    const total = core.totals(files);
    const summary = new vscode.TreeItem(`Lines ${total.covered}/${total.total} · ${pct(total.percent)}`, vscode.TreeItemCollapsibleState.None);
    summary.iconPath = new vscode.ThemeIcon('graph');
    return [summary, ...files.map(f => { const it = new vscode.TreeItem(`${f.path}  ${f.covered}/${f.total} (${pct(f.percent)})`, vscode.TreeItemCollapsibleState.None); it.resourceUri = vscode.Uri.file(f.absolute); it.command = { command: 'vscode.open', title: 'Open covered file', arguments: [it.resourceUri] }; it.iconPath = new vscode.ThemeIcon(f.percent < 50 ? 'warning' : 'check'); it.description = f.format; return it; })];
  }
  provideFileDecoration(uri) {
    const f = files.find(x => path.normalize(x.absolute) === path.normalize(uri.fsPath));
    if (!f) return undefined;
    return { badge: String(Math.round(f.percent)), tooltip: `${f.path}: ${f.covered}/${f.total} lines (${pct(f.percent)})`, color: new vscode.ThemeColor(f.percent < 50 ? 'editorError.foreground' : 'editorInfo.foreground') };
  }
}
function reportDoc(content, language = 'markdown') { return vscode.workspace.openTextDocument({ language, content }).then(doc => vscode.window.showTextDocument(doc, { preview: true })); }
function git(args, cwd) { return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(out))); }
function parseChanged(text, cwd) {
  const out = {}; let file = null, line = 0;
  for (const row of text.split(/\r?\n/)) {
    const m = /^\+\+\+ b\/(.+)$/.exec(row); if (m) { file = path.resolve(cwd, m[1]); (out[file] ||= []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row); if (h) { line = Number(h[1]); continue; }
    if (row.startsWith('+') && !row.startsWith('+++') && file) out[file].push(line++);
    else if (row.startsWith(' ') && file) line++;
  }
  return out;
}
function createPro(context) {
  const license = createLicense({ vscode, context, sku: 'code-coverage-pro', name: 'Zovo', commandPrefix: PREFIX, product: 'Code Coverage' });
  const title = id => (TOOLS.find(t => t.id === id) || { title: id }).title;
  const trials = createTrialAccess(context.globalState, TRIES_KEY, 3, (id, used) => { vscode.window.setStatusBarMessage(`Code Coverage: ${title(id)}, free try ${used} of 3.`, 6000); if (reach) reach.refresh(); });
  async function allow(id, detail) {
    await license.ready;
    if (license.isPro('code-coverage-pro')) { license.refresh().catch(() => {}); return { async done() {} }; }
    const access = trials.allow(id); if (access) return access;
    const ok = await license.requirePro(title(id), withSurface({ detail: `${detail} You used the three free tries on this computer.`, tools: TOOLS.map(t => t.title) }));
    return ok ? { async done() {} } : false;
  }
  return { license, allow, licensed: () => license.isPro('code-coverage-pro') };
}
function escHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function summaryHtml(webview, nonce) {
  const t = core.totals(files);
  const rows = files.map((f, i) => `<tr data-i="${i}" tabindex="0"><td class="file">${escHtml(f.path)}</td><td class="num">${f.covered}/${f.total}</td><td class="num ${f.percent < 50 ? 'low' : ''}">${pct(f.percent)}</td><td class="num">${f.branchTotal ? `${f.branchCovered}/${f.branchTotal}` : ''}</td><td class="fmt">${escHtml(f.format)}</td></tr>`).join('');
  const empty = files.length ? '' : '<p class="empty">No coverage report loaded. Put an LCOV, Cobertura, JaCoCo or Clover report in this workspace, then choose Refresh.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width">
<style nonce="${nonce}">body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:0 16px 24px}#bar{position:sticky;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}#bar strong{font-size:13px}#bar button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:2px 10px;border-radius:2px;cursor:pointer}.totals{display:flex;gap:28px;margin:14px 0}.totals b{display:block;font-size:20px}table{border-collapse:collapse;width:100%}th,td{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left}th{font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.low{color:var(--vscode-errorForeground)}tr[data-i]{cursor:pointer}tr[data-i]:hover,tr[data-i]:focus{background:var(--vscode-list-hoverBackground);outline:none}.fmt{opacity:.7}.empty{opacity:.8}</style>
${reach ? reach.headHtml(nonce) : ''}</head><body>
<div id="bar"><strong>Code coverage</strong><button id="refresh" type="button">Refresh</button><span class="reach-slot"></span></div>
<div class="totals"><div><b>${pct(t.percent)}</b>lines ${t.covered}/${t.total}</div><div><b>${t.branchTotal ? pct(t.branchPercent) : 'n/a'}</b>branches ${t.branchCovered}/${t.branchTotal}</div><div><b>${t.files}</b>files</div></div>
${empty}${files.length ? `<table><thead><tr><th>File (least covered first)</th><th class="num">Lines</th><th class="num">Percent</th><th class="num">Branches</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<script nonce="${nonce}">(function(){const api=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>api.postMessage({type:'refresh'}));document.addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('tr[data-i]');if(r)api.postMessage({type:'open',i:Number(r.dataset.i)});});document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.dataset&&e.target.dataset.i)api.postMessage({type:'open',i:Number(e.target.dataset.i)});});})();</script>
</body></html>`;
}
function renderSummary() {
  if (!summaryPanel) return;
  const nonce = require('node:crypto').randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  summaryPanel.webview.html = summaryHtml(summaryPanel.webview, nonce);
}
function showSummary(context) {
  if (summaryPanel) { renderSummary(); summaryPanel.reveal(undefined, true); return; }
  summaryPanel = vscode.window.createWebviewPanel('codeCoverage.summary', 'Code Coverage Summary', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, enableCommandUris: reach ? reach.commandIds() : [], localResourceRoots: [] });
  if (reach) reach.attach(summaryPanel.webview, summaryPanel);
  summaryPanel.onDidDispose(() => { summaryPanel = null; }, null, context.subscriptions);
  summaryPanel.webview.onDidReceiveMessage(async msg => {
    if (reach && reach.onMessage(msg)) return;
    if (msg && msg.type === 'refresh') { await vscode.commands.executeCommand('codeCoverage.refresh'); renderSummary(); }
    if (msg && msg.type === 'open' && files[msg.i]) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(files[msg.i].absolute), { viewColumn: vscode.ViewColumn.One });
  }, null, context.subscriptions);
  renderSummary();
}
function activate(context) {
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT, section: PREFIX, name: 'Code Coverage' });
  const pro = createPro(context), tree = new CoverageTree();
  reach = createReach({ vscode, context, prefix: PREFIX, triesKey: TRIES_KEY, slot: '#bar .reach-slot', tools: TOOLS, licensed: () => pro.licensed(), shown: () => vscode.workspace.getConfiguration(PREFIX).get('showProTools', true) !== false });
  reach.registerCtx();
  context.subscriptions.push(pro.license.onDidChange ? pro.license.onDidChange(() => reach.refresh()) : { dispose() {} });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  context.subscriptions.push(output, vscode.window.registerTreeDataProvider('codeCoverage.files', tree), vscode.window.registerFileDecorationProvider(tree), missedMark, hitMark, branchMark,
    vscode.window.onDidChangeActiveTextEditor(mark));
  const refresh = async () => { await loadReports(); tree.refresh(); mark(vscode.window.activeTextEditor); vscode.commands.executeCommand('setContext', 'codeCoverage.loaded', files.length > 0); return files; };
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.refresh', refresh));
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.report', async () => { await refresh(); showSummary(context); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.diff', reach.wrap(async () => {
    const gate = await pro.allow('diff', 'Checks whether added or changed lines have test coverage.'); if (!gate) return;
    try { await refresh(); const diff = await git(['diff', '--unified=0', 'main...HEAD', '--'], rootPath || root()); const result = core.diffCoverage(files, parseChanged(diff, rootPath));
      const body = ['# Diff coverage against main', '', `Covered lines: ${result.covered}/${result.total} (${pct(result.percent)})`, '', ...result.missed.map(x => `- ${x.file}:${x.line}${x.reported ? '' : ' (not in loaded report)'}`), '']; await reportDoc(body.join('\n')); await gate.done();
    } catch (e) { vscode.window.showErrorMessage(`Diff coverage failed: ${e.message}`); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.export', reach.wrap(async () => {
    const gate = await pro.allow('export', 'Writes a shareable HTML or Markdown report to the selected folder.'); if (!gate) return;
    await refresh(); const choice = await vscode.window.showQuickPick(['Markdown', 'HTML'], { placeHolder: 'Choose a report format' }); if (!choice) return;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(rootPath, `coverage-report.${choice === 'HTML' ? 'html' : 'md'}`)) }); if (!uri) return;
    const content = choice === 'HTML' ? core.htmlReport(files) : core.markdownReport(files);
    await fs.writeFile(uri.fsPath, content, 'utf8'); await gate.done(); vscode.window.showInformationMessage(`Coverage report saved to ${path.basename(uri.fsPath)}.`);
  })));
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.history', reach.wrap(async () => {
    const gate = await pro.allow('history', 'Saves coverage snapshots and checks the configured line threshold with a JSON result for CI.'); if (!gate) return;
    await refresh(); const t = core.totals(files), list = context.workspaceState.get(historyKey, []); const now = new Date().toISOString();
    const previous = list[list.length - 1];
    list.push({ at: now, lines: t.covered, total: t.total, percent: t.percent }); await context.workspaceState.update(historyKey, list.slice(-100));
    const threshold = Number(context.workspaceState.get('threshold', 0)); const result = { ...t, leastCovered: t.leastCovered.map(f => ({ path: f.path, covered: f.covered, total: f.total, percent: Number(f.percent.toFixed(2)) })), at: now, threshold, passed: t.percent >= threshold, changeFromPreviousRun: previous ? Number((t.percent - previous.percent).toFixed(2)) : null, history: list.slice(-12) };
    await reportDoc(JSON.stringify(result, null, 2), 'json'); await gate.done();
  })));
  context.subscriptions.push(vscode.commands.registerCommand('codeCoverage.threshold', async () => {
    const gate = await pro.allow('history', 'Sets the line coverage threshold used by the history and CI command.'); if (!gate) return;
    const answer = await vscode.window.showInputBox({ prompt: 'Minimum line coverage percent', value: String(context.workspaceState.get('threshold', 80)), validateInput: x => Number(x) >= 0 && Number(x) <= 100 ? null : 'Use a number from 0 to 100.' });
    if (answer === undefined) return; await context.workspaceState.update('threshold', Number(answer)); await gate.done();
  }));
  refresh().catch(e => output.appendLine(`Could not read coverage reports: ${e.message}`));
}
module.exports = { activate };

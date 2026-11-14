'use strict';
const path = require('node:path');

function lcov(text) {
  const files = new Map(); let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('SF:')) { current = { path: line.slice(3), lines: new Map(), branches: new Map(), format: 'lcov' }; files.set(current.path, current); }
    else if (current && line.startsWith('DA:')) { const [n, hits] = line.slice(3).split(',').map(Number); if (Number.isFinite(n) && Number.isFinite(hits)) current.lines.set(n, hits); }
    else if (current && line.startsWith('BRDA:')) { const [lineNo, block, branch, taken] = line.slice(5).split(','); const key = `${lineNo}:${block}:${branch}`; current.branches.set(key, taken === '-' ? null : Number(taken)); }
    else if (line === 'end_of_record') current = null;
  }
  return [...files.values()];
}
function xmlAttrs(text) { const out = {}; for (const m of text.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) out[m[1]] = m[3]; return out; }
function xmlReports(text, format) {
  const out = [];
  if (format === 'cobertura') {
    for (const file of text.matchAll(/<class\b([^>]*)(?:>([\s\S]*?)<\/class\s*>|\s*\/?>)/g)) {
      const a = xmlAttrs(file[1]), body = file[2] || '', p = a.filename || a.name;
      if (!p) continue;
      const row = { path: p, lines: new Map(), branches: new Map(), format };
      for (const m of body.matchAll(/<line\b([^>]*?)\/?\s*>/g)) { const x = xmlAttrs(m[1]), n = Number(x.number); if (n) { row.lines.set(n, Number(x.hits) || 0); const b = x['condition-coverage']?.match(/\((\d+)\/(\d+)\)/); if (b) for (let i = 0; i < Number(b[2]); i++) row.branches.set(`${n}:${i}`, i < Number(b[1]) ? 1 : 0); } }
      out.push(row);
    }
  } else if (format === 'jacoco') {
    for (const pkg of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package\s*>/g)) {
      const packageName = xmlAttrs(pkg[1]).name || '';
      for (const sf of pkg[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile\s*>/g)) {
        const a = xmlAttrs(sf[1]); if (!a.name) continue;
        const row = { path: [packageName.replace(/\./g, '/'), a.name].filter(Boolean).join('/'), lines: new Map(), branches: new Map(), format };
        for (const m of sf[2].matchAll(/<line\b([^>]*?)\/?\s*>/g)) { const x = xmlAttrs(m[1]), n = Number(x.nr); if (n) { row.lines.set(n, Number(x.ci) > 0 ? 1 : 0); const total = Number(x.cb) || 0, hit = Math.max(0, total - (Number(x.mb) || 0)); for (let i = 0; i < total; i++) row.branches.set(`${n}:${i}`, i < hit ? 1 : 0); } }
        out.push(row);
      }
    }
  } else if (format === 'clover') {
    for (const f of text.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file\s*>/g)) {
      const a = xmlAttrs(f[1]), p = a.path || a.name; if (!p) continue;
      const row = { path: p, lines: new Map(), branches: new Map(), format };
      for (const m of f[2].matchAll(/<line\b([^>]*?)\/?\s*>/g)) { const x = xmlAttrs(m[1]), n = Number(x.num); if (n && x.type === 'stmt') row.lines.set(n, Number(x.count) || 0); }
      out.push(row);
    }
  }
  return out;
}
function parseReport(text, format) {
  if (format === 'lcov' || format === 'info') return lcov(text);
  if (!['cobertura', 'jacoco', 'clover'].includes(format)) throw new Error(`Unsupported coverage format: ${format}`);
  return xmlReports(text, format);
}
function stats(file) {
  const lines = [...file.lines.values()], branches = [...file.branches.values()].filter(Number.isFinite);
  const covered = lines.filter(x => x > 0).length, branchCovered = branches.filter(x => x > 0).length;
  return { path: file.path, format: file.format, covered, total: lines.length, percent: lines.length ? covered / lines.length * 100 : 0, branchCovered, branchTotal: branches.length, branchPercent: branches.length ? branchCovered / branches.length * 100 : 0, missed: [...file.lines].filter(([, hits]) => hits === 0).map(([line]) => line).sort((a, b) => a - b) };
}
// Report rank inside one folder: test runners often write several formats of the same run side by side (jest writes
// coverage/lcov.info and coverage/clover.xml). Loading both would count every file twice, so only the best one per
// folder is read.
const REPORT_RANK = ['lcov.info', 'coverage.xml', 'cobertura.xml', 'jacoco.xml', 'clover.xml'];
function reportRank(file) {
  const name = path.basename(file).toLowerCase();
  const i = REPORT_RANK.indexOf(name);
  return i >= 0 ? i : name.endsWith('.info') ? 0.5 : REPORT_RANK.length;
}
function pickReports(files) {
  const best = new Map();
  for (const file of files) {
    const dir = path.dirname(path.normalize(file)), old = best.get(dir);
    if (!old || reportRank(file) < reportRank(old)) best.set(dir, file);
  }
  return [...best.values()];
}
// A report path can be relative, absolute inside the workspace, or absolute from the machine that ran the tests
// (CI or another checkout). The last kind is mapped to the longest path suffix that exists in the workspace.
function resolveReportPath(file, root, exists = () => false) {
  const normal = String(file).replace(/\\/g, '/');
  if (!path.isAbsolute(normal) && !/^[A-Za-z]:\//.test(normal)) return path.resolve(root, normal);
  const absolute = path.normalize(normal);
  if (absolute === root || absolute.startsWith(root + path.sep)) return absolute;
  const parts = normal.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const candidate = path.join(root, ...parts.slice(i));
    if (exists(candidate)) return candidate;
  }
  return absolute;
}
function mergeReports(reports, root, exists) {
  const merged = new Map();
  for (const report of reports) for (const f of report) {
    const absolute = resolveReportPath(f.path, root, exists); const key = path.normalize(absolute);
    const old = merged.get(key) || { path: absolute.startsWith(root + path.sep) ? path.relative(root, absolute) : f.path, absolute, lines: new Map(), branches: new Map(), format: f.format };
    for (const [n, hits] of f.lines) old.lines.set(n, Math.max(old.lines.get(n) || 0, hits));
    for (const [n, hits] of f.branches) old.branches.set(n, Math.max(old.branches.get(n) || 0, hits || 0));
    merged.set(key, old);
  }
  // Least covered first; files with no instrumented lines (type-only files) go last.
  return [...merged.values()].map(f => ({ ...f, ...stats(f) })).sort((a, b) => (a.total === 0) - (b.total === 0) || a.percent - b.percent || a.path.localeCompare(b.path));
}
function totals(files) {
  const covered = files.reduce((n, f) => n + f.covered, 0), total = files.reduce((n, f) => n + f.total, 0);
  const branchCovered = files.reduce((n, f) => n + f.branchCovered, 0), branchTotal = files.reduce((n, f) => n + f.branchTotal, 0);
  return { files: files.length, covered, total, percent: total ? covered / total * 100 : 0, branchCovered, branchTotal, branchPercent: branchTotal ? branchCovered / branchTotal * 100 : 0, leastCovered: files.filter(f => f.total > 0).slice(0, 10) };
}
function diffCoverage(files, changedLines) {
  const byPath = new Map(files.map(f => [path.normalize(f.absolute || f.path), f]));
  const rows = [];
  for (const [file, lines] of Object.entries(changedLines)) {
    const f = byPath.get(path.normalize(file));
    for (const line of lines) rows.push({ file, line, covered: f ? (f.lines.get(line) || 0) > 0 : false, reported: !!f?.lines.has(line) });
  }
  const hit = rows.filter(x => x.covered).length;
  return { rows, covered: hit, total: rows.length, percent: rows.length ? hit / rows.length * 100 : 0, missed: rows.filter(x => !x.covered) };
}
function markdownReport(files) {
  const t = totals(files);
  const cell = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return ['# Code coverage report', '', `Lines: ${t.covered}/${t.total} (${t.percent.toFixed(1)}%)`, `Branches: ${t.branchCovered}/${t.branchTotal} (${t.branchPercent.toFixed(1)}%)`, '', '| File | Lines | Branches |', '| --- | ---: | ---: |', ...files.map(f => `| ${cell(f.path)} | ${f.covered}/${f.total} (${f.percent.toFixed(1)}%) | ${f.branchCovered}/${f.branchTotal} (${f.branchPercent.toFixed(1)}%) |`), ''].join('\n');
}
function htmlReport(files) {
  const t = totals(files), esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = files.map(f => `<tr><td>${esc(f.path)}</td><td>${f.covered}/${f.total} (${f.percent.toFixed(1)}%)</td><td>${f.branchCovered}/${f.branchTotal} (${f.branchPercent.toFixed(1)}%)</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Code coverage report</title><style>body{font:15px system-ui,sans-serif;max-width:1050px;margin:36px auto;padding:0 20px;color:#20242a}table{border-collapse:collapse;width:100%}th,td{padding:9px 12px;border:1px solid #cbd0d6;text-align:left}th{background:#f1f3f5}h1{margin-bottom:8px}.summary{color:#4b5563;margin-bottom:22px}</style><main><h1>Code coverage report</h1><p class="summary">${t.covered} of ${t.total} lines covered (${t.percent.toFixed(1)}%). ${t.branchCovered} of ${t.branchTotal} branches covered (${t.branchPercent.toFixed(1)}%).</p><table><thead><tr><th>File</th><th>Lines</th><th>Branches</th></tr></thead><tbody>${rows}</tbody></table></main></html>`;
}
module.exports = { lcov, xmlReports, parseReport, stats, pickReports, resolveReportPath, mergeReports, totals, diffCoverage, markdownReport, htmlReport };

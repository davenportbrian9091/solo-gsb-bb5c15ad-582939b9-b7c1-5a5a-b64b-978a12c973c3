/* MIME Multipart 检查器前端（无框架原生实现） */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let parseResult = null;       // 最近一次解析返回
let tree = null;              // 当前可编辑树（对象引用，控件直接改它）
let encodedBytes = null;      // Uint8Array 编码结果
const issueFilter = { error: true, warning: true, info: true };

// 样本对比：A/B 两份快照（含完整解析结果，保存在 localStorage）
const snapshots = { a: null, b: null };
let diffReport = null;        // 最近一次 /api/diff 返回
let editorSource = null;      // 当前编辑器内容来源："a" | "b" | null（新解析）

// ---------------------------------------------------------------- samples --

// 说明：RFC 2046 要求首定界符前有 CRLF；顶层头部块后的空行已提供该 CRLF，
// 因此 body 直接以 "--boundary" 开始（HTTP multipart 的常见形态）。
const SAMPLE_BASIC =
  'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryABC\r\n' +
  '\r\n' +
  '------WebKitFormBoundaryABC\r\n' +
  'Content-Disposition: form-data; name="username"\r\n' +
  '\r\n' +
  'alice@example.com\r\n' +
  '------WebKitFormBoundaryABC\r\n' +
  'Content-Disposition: form-data; name="bio"\r\n' +
  '\r\n' +
  '你好，MIME！\r\n' +
  '------WebKitFormBoundaryABC\r\n' +
  'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'line1\r\n' +
  'line2\r\n' +
  '------WebKitFormBoundaryABC--';

const SAMPLE_NESTED =
  'Content-Type: multipart/mixed; boundary="OUTER-001"\r\n' +
  'MIME-Version: 1.0\r\n' +
  '\r\n' +
  'This is a MIME-formatted message.  If you see this, your mailer is broken.\r\n' +
  '--OUTER-001\r\n' +
  'Content-Type: text/plain; charset="utf-8"\r\n' +
  'Content-Transfer-Encoding: 7bit\r\n' +
  '\r\n' +
  '外层正文：请查收附件。\r\n' +
  '--OUTER-001\r\n' +
  'Content-Type: multipart/alternative; boundary="INNER-42"\r\n' +
  '\r\n' +
  '--INNER-42\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  '\r\n' +
  'plain 版本\r\n' +
  '--INNER-42\r\n' +
  'Content-Type: text/html; charset=utf-8\r\n' +
  '\r\n' +
  '<p><b>HTML</b> 版本</p>\r\n' +
  '--INNER-42--\r\n' +
  '--OUTER-001\r\n' +
  'Content-Disposition: attachment; filename="report.csv"\r\n' +
  'Content-Type: text/csv\r\n' +
  '\r\n' +
  'id,name\r\n' +
  '1,张三\r\n' +
  '--OUTER-001--\r\n' +
  'epilogue text, must be ignored';

const SAMPLE_BAD =
  // 故意使用 LF、缺关闭定界符、畸形头部
  'Content-Type: multipart/form-data; boundary="BROKEN"\n' +
  '\n' +
  '--BROKEN\n' +
  'Content-Disposition: form-data; name="ok"\n' +
  '\n' +
  'good part\n' +
  '--BROKEN\n' +
  'this line is not a valid header (no colon)\n' +
  'Content-Disposition: form-data; name="bad"\n' +
  '\n' +
  'second part\n' +
  '--BROKEN\n' +
  'Content-Type: multipart/mixed; boundary=CHILD\n' +
  '\n' +
  '--CHILD\n' +
  '\n' +
  'nested child\n' +
  '--CHILD--';

// ------------------------------------------------------------- utilities --

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    throw new Error((data && (data.detail || data.error)) || `HTTP ${res.status}`);
  }
  return data;
}

function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------- issues --

function renderIssues(listEl, issues) {
  listEl.innerHTML = "";
  const shown = issues.filter((i) => issueFilter[i.level] !== false);
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "info";
    li.innerHTML = '<span class="tag">OK</span><span class="msg">当前筛选下没有诊断信息</span>';
    listEl.appendChild(li);
    return;
  }
  for (const it of shown) {
    const li = document.createElement("li");
    li.className = it.level;
    const label = it.level === "error" ? "错误" : it.level === "warning" ? "警告" : "提示";
    li.innerHTML =
      `<span class="tag">${label}</span>` +
      `<span class="code">${escapeHtml(it.code || "")}</span>` +
      `<span class="msg">${escapeHtml(it.message || "")}</span>`;
    listEl.appendChild(li);
  }
}

function setCounts(counts) {
  counts = counts || { error: 0, warning: 0, info: 0 };
  $("#cntError").textContent = counts.error || 0;
  $("#cntWarning").textContent = counts.warning || 0;
  $("#cntInfo").textContent = counts.info || 0;
}

// ------------------------------------------------------------ tree view --

function reindexPaths(node, path) {
  node.path = path;
  if (node.kind === "multipart") {
    node.parts.forEach((c, i) => reindexPaths(c, `${path === "root" ? "parts" : path + ".parts"}[${i}]`));
  }
}

function newPartNode(index) {
  return {
    kind: "part",
    path: `parts[${index}]`,
    mediaType: "text/plain",
    headers: [
      { name: "Content-Type", value: "text/plain", raw: "" },
      { name: "Content-Disposition", value: `form-data; name="part${index + 1}"`, raw: "" },
    ],
    hasHeaders: true,
    body: "",
    bodyEncoding: "utf-8",
    rawSize: 0,
  };
}

function headerRow(table, node, idx) {
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td><input type="text" spellcheck="false" placeholder="Header-Name"></td>` +
    `<td><input type="text" spellcheck="false" placeholder="value"></td>` +
    `<td class="del-cell"><button class="btn btn-sm btn-danger" type="button">删</button></td>`;
  const [nameIn, valIn] = $$("input", tr);
  nameIn.value = node.headers[idx].name || "";
  valIn.value = node.headers[idx].value || "";
  nameIn.addEventListener("input", () => { node.headers[idx].name = nameIn.value; });
  valIn.addEventListener("input", () => { node.headers[idx].value = valIn.value; });
  $("button", tr).addEventListener("click", () => {
    node.headers.splice(idx, 1);
    rerenderTree();
  });
  return tr;
}

function renderNode(node, depth) {
  const wrap = document.createElement("div");
  wrap.className = "node";
  wrap.dataset.path = node.path || "";
  const isMulti = node.kind === "multipart";

  const titleParts = [];
  if (node.name != null) titleParts.push(`name=<b>${escapeHtml(node.name)}</b>`);
  if (node.filename) titleParts.push(`filename=<b>${escapeHtml(node.filename)}</b>`);
  const titleExtra = titleParts.length ? ` · ${titleParts.join(" · ")}` : "";

  const bar = document.createElement("div");
  bar.className = "node-bar";
  bar.innerHTML =
    `<span class="caret">▼</span>` +
    `<span class="badge ${isMulti ? "multipart" : ""}">${escapeHtml(node.mediaType || (isMulti ? "multipart/*" : "application/octet-stream"))}</span>` +
    `<span class="node-title">${escapeHtml(node.path)}${titleExtra}</span>` +
    `<span class="node-spacer"></span>` +
    `<span class="node-size">${humanSize(node.rawSize || 0)}</span>`;
  bar.addEventListener("click", (e) => {
    if (e.target.closest("button, input, a")) return;
    wrap.classList.toggle("collapsed");
  });
  wrap.appendChild(bar);

  const body = document.createElement("div");
  body.className = "node-body";

  // boundary 编辑（仅 multipart）
  if (isMulti) {
    const br = document.createElement("div");
    br.className = "inline-row";
    br.innerHTML =
      `<label>boundary</label>` +
      `<input type="text" spellcheck="false">` +
      `<span class="meta-pill">定界符 --${escapeHtml(node.boundary || "")} / --${escapeHtml(node.boundary || "")}--</span>`;
    const bIn = $("input", br);
    bIn.value = node.boundary || "";
    bIn.addEventListener("input", () => { node.boundary = bIn.value; });
    bIn.addEventListener("click", (e) => e.stopPropagation());
    body.appendChild(br);
  }

  // 头部表
  const hdrLabel = document.createElement("label");
  hdrLabel.textContent = "头部（按输入顺序保留）";
  body.appendChild(hdrLabel);
  const table = document.createElement("table");
  table.className = "headers-table";
  table.innerHTML = `<tr><th>字段名</th><th>值</th><th></th></tr>`;
  node.headers.forEach((_h, idx) => table.appendChild(headerRow(table, node, idx)));
  body.appendChild(table);
  const addHdr = document.createElement("button");
  addHdr.className = "btn btn-sm add-row";
  addHdr.type = "button";
  addHdr.textContent = "+ 添加头部";
  addHdr.addEventListener("click", () => {
    node.headers.push({ name: "", value: "", raw: "" });
    rerenderTree();
  });
  body.appendChild(addHdr);

  if (isMulti) {
    // preamble / epilogue
    for (const key of ["preamble", "epilogue"]) {
      const encKey = key + "Encoding";
      const isBin = node[encKey] === "base64";
      const lab = document.createElement("label");
      const title = key === "preamble"
        ? "序言 preamble（非 MIME 客户端可见，通常无意义）"
        : "尾注 epilogue（关闭定界符之后）";
      lab.innerHTML = `${title} <span class="meta-pill ${isBin ? "latin" : ""}">` +
        `${isBin ? "二进制 · base64（未修改即逐字节还原）" : node[encKey]}</span>`;
      body.appendChild(lab);
      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.value = node[key] || "";
      ta.addEventListener("input", () => { node[key] = ta.value; });
      body.appendChild(ta);
    }

    // 子部分
    const childWrap = document.createElement("div");
    childWrap.className = "sub-node-wrap";
    node.parts.forEach((child) => childWrap.appendChild(renderNode(child, depth + 1)));

    const addPart = document.createElement("button");
    addPart.className = "btn btn-sm add-row";
    addPart.type = "button";
    addPart.textContent = "+ 在末尾插入部分";
    addPart.addEventListener("click", () => {
      node.parts.push(newPartNode(node.parts.length));
      rerenderTree();
    });
    childWrap.appendChild(addPart);
    body.appendChild(childWrap);
  } else {
    const lab = document.createElement("label");
    const enc = node.bodyEncoding || "utf-8";
    const isBin = enc === "base64";
    lab.innerHTML = `正文 <span class="meta-pill ${isBin ? "latin" : ""}">` +
      `${isBin ? "二进制 · base64（未修改即逐字节还原）" : enc}</span>`;
    body.appendChild(lab);
    if (isBin) {
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = "该部分不是合法 UTF-8，以 base64 展示。直接编辑会被当作 base64 解码；"
        + "若想改为纯文本，请把内容替换为文本即可（将自动按 latin-1 还原字节）。";
      body.appendChild(note);
    }
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.value = node.body || "";
    ta.addEventListener("input", () => { node.body = ta.value; });
    body.appendChild(ta);
  }

  // 删除按钮（根节点不显示）
  if (node.path !== "root") {
    const delRow = document.createElement("div");
    delRow.className = "add-row";
    const del = document.createElement("button");
    del.className = "btn btn-sm btn-danger";
    del.type = "button";
    del.textContent = "删除该部分";
    del.addEventListener("click", () => {
      const parent = findParent(tree, node);
      if (parent) {
        parent.parts = parent.parts.filter((p) => p !== node);
        rerenderTree();
      }
    });
    delRow.appendChild(del);
    body.appendChild(delRow);
  }

  wrap.appendChild(body);
  return wrap;
}

function findParent(root, target) {
  if (root.kind !== "multipart") return null;
  for (const p of root.parts) {
    if (p === target) return root;
    const found = findParent(p, target);
    if (found) return found;
  }
  return null;
}

function rerenderTree() {
  const rootEl = $("#treeRoot");
  rootEl.innerHTML = "";
  reindexPaths(tree, "root");
  rootEl.appendChild(renderNode(tree, 0));
}

// ---------------------------------------------------------------- actions --

function fillSample(ta, text) {
  $("#rawInput").value = text;
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (/content-type\s*:/i.test(firstLine)) {
    const m = firstLine.match(/content-type\s*:\s*(.+)/i);
    if (m) $("#contentTypeInput").value = m[1].trim();
  } else {
    $("#contentTypeInput").value = "";
  }
  $("#boundaryInput").value = "";
}

async function doParse() {
  const raw = $("#rawInput").value;
  if (!raw.trim()) {
    alert("请先粘贴报文或载入示例");
    return;
  }
  $("#btnParse").disabled = true;
  try {
    const rawBytes = new TextEncoder().encode($("#rawInput").value);
    const data = await postJSON("/api/parse", {
      raw: $("#rawInput").value,
      rawBase64: bytesToB64(rawBytes),
      contentType: $("#contentTypeInput").value || null,
      boundary: $("#boundaryInput").value || null,
    });
    parseResult = data;
    tree = data.tree;
    editorSource = null;      // 新解析结果，与已保存样本无关联
    setCounts(data.counts);
    $("#effectiveBoundary").textContent = data.effectiveBoundary ?? "—（无）";
    const metaBits = [];
    metaBits.push(`媒体类型 <b>${escapeHtml(data.mediaType || "—")}</b>`);
    metaBits.push(`原始大小 <b>${humanSize(tree.rawSize || 0)}</b>`);
    metaBits.push(`行结束 <b>${data.normalizedCrlf ? "已规范化为 CRLF" : "CRLF"}</b>`);
    metaBits.push(`顶层头部 <b>${data.hasTopHeaders ? "检测到" : "未检测到"}</b>`);
    $("#parseMeta").innerHTML = metaBits.join("　·　");

    $("#issuesCard").classList.remove("hidden");
    $("#treeCard").classList.remove("hidden");
    $("#outputCard").classList.add("hidden");
    renderIssues($("#issuesList"), data.issues);
    rerenderTree();
    renderSnapSlots();
  } catch (e) {
    alert("解析失败：" + e.message);
  } finally {
    $("#btnParse").disabled = false;
  }
}

async function doEncode(andDownload = true) {
  if (!tree) return;
  reindexPaths(tree, "root");
  $("#btnEncode").disabled = true;
  try {
    const data = await postJSON("/api/encode", {
      tree,
      includeHeaders: $("#includeHeaders").checked,
    });
    encodedBytes = b64ToBytes(data.payloadBase64);
    $("#outputCard").classList.remove("hidden");
    const ok = (data.counts?.error || 0) === 0;
    $("#encodeMeta").innerHTML =
      (ok ? "✅ 编码成功" : "⚠️ 编码完成但存在错误") +
      `　·　大小 <b>${humanSize(data.size)}</b>　·　行结束 <b>${data.lineEnding}</b>`;
    renderIssues($("#encodeIssues"), data.issues);
    const preview = bytesToText(encodedBytes);
    $("#outputPreview").value = preview;
    if (andDownload && ok) downloadBlob();
    if (!ok) {
      $("#outputCard").scrollIntoView({ behavior: "smooth" });
    }
  } catch (e) {
    alert("编码失败：" + e.message);
  } finally {
    $("#btnEncode").disabled = false;
  }
}

function bytesToText(bytes) {
  // 优先 UTF-8，失败按 latin-1
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

function currentFilename() {
  let name = ($("#filenameInput").value || "message.eml").trim();
  name = name.replace(/[\\/]/g, "_");
  return name;
}

function downloadBlob() {
  if (!encodedBytes) return;
  const blob = new Blob([encodedBytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyOutput() {
  if (!encodedBytes) return;
  const text = bytesToText(encodedBytes);
  try {
    await navigator.clipboard.writeText(text);
    $("#btnCopy").textContent = "已复制";
    setTimeout(() => ($("#btnCopy").textContent = "复制为文本"), 1200);
  } catch (_) {
    const ta = $("#outputPreview");
    ta.classList.remove("hidden");
    ta.select();
    document.execCommand("copy");
  }
}

// ---------------------------------------------------------- sample compare --

const SNAP_LS_KEY = { a: "mimeSnapA", b: "mimeSnapB" };

const DIFF_KIND_LABEL = { added: "新增", removed: "删除", modified: "修改" };
const DIFF_FIELD_LABEL = {
  kind: "节点类型",
  mediaType: "媒体类型",
  headers: "头部",
  boundary: "boundary",
  leadingCrlf: "首定界符前 CRLF",
  preamble: "序言 preamble",
  preambleEncoding: "序言编码",
  epilogue: "尾注 epilogue",
  epilogueEncoding: "尾注编码",
  hasHeaders: "头部块",
  body: "正文",
  bodyEncoding: "正文编码",
  issues: "诊断代码",
};

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

function saveSnapshot(side) {
  if (!parseResult || !tree) {
    alert("请先解析一份报文，再保存为样本");
    return;
  }
  reindexPaths(tree, "root");
  const result = deepClone(parseResult);   // parseResult.tree 即当前编辑器树
  snapshots[side] = {
    label: `样本 ${side.toUpperCase()}`,
    savedAt: new Date().toISOString(),
    result,
  };
  persistSnapshot(side);
  resetDiffView();
  renderSnapSlots();
}

function loadSnapshotIntoEditor(side) {
  const snap = snapshots[side];
  if (!snap) return false;
  parseResult = deepClone(snap.result);    // 深拷贝，编辑器改动不污染样本
  tree = parseResult.tree;
  editorSource = side;
  setCounts(parseResult.counts);
  $("#effectiveBoundary").textContent = parseResult.effectiveBoundary ?? "—（无）";
  const metaBits = [];
  metaBits.push(`媒体类型 <b>${escapeHtml(parseResult.mediaType || "—")}</b>`);
  metaBits.push(`原始大小 <b>${humanSize(tree.rawSize || 0)}</b>`);
  metaBits.push(`行结束 <b>${parseResult.normalizedCrlf ? "已规范化为 CRLF" : "CRLF"}</b>`);
  metaBits.push(`顶层头部 <b>${parseResult.hasTopHeaders ? "检测到" : "未检测到"}</b>`);
  metaBits.push(`来源 <b>${escapeHtml(snap.label)}</b>`);
  $("#parseMeta").innerHTML = metaBits.join("　·　");
  $("#issuesCard").classList.remove("hidden");
  $("#treeCard").classList.remove("hidden");
  renderIssues($("#issuesList"), parseResult.issues || []);
  rerenderTree();
  return true;
}

function clearSnapshot(side) {
  snapshots[side] = null;
  persistSnapshot(side);
  resetDiffView();
  renderSnapSlots();
}

function persistSnapshot(side) {
  try {
    if (snapshots[side]) {
      localStorage.setItem(SNAP_LS_KEY[side], JSON.stringify(snapshots[side]));
    } else {
      localStorage.removeItem(SNAP_LS_KEY[side]);
    }
  } catch (_) {
    // 隐私模式 / 超出配额：仅保留内存副本
  }
}

function restoreSnapshots() {
  for (const side of ["a", "b"]) {
    try {
      const raw = localStorage.getItem(SNAP_LS_KEY[side]);
      if (raw) snapshots[side] = JSON.parse(raw);
    } catch (_) { /* 损坏的缓存直接忽略 */ }
  }
}

function snapshotMeta(side) {
  const snap = snapshots[side];
  if (!snap) return null;
  const r = snap.result || {};
  const t = r.tree || {};
  return {
    label: snap.label,
    savedAt: snap.savedAt,
    mediaType: r.mediaType ?? null,
    rawSize: t.rawSize ?? null,
    counts: r.counts ?? null,
  };
}

function renderSnapSlots() {
  for (const side of ["a", "b"]) {
    const S = side.toUpperCase();
    const snap = snapshots[side];
    const metaEl = $("#snapMeta" + S);
    if (snap) {
      const r = snap.result || {};
      const t = r.tree || {};
      const c = r.counts || {};
      const when = (snap.savedAt || "").replace("T", " ").slice(0, 19);
      metaEl.innerHTML =
        `<b>${escapeHtml(r.mediaType || "—")}</b> · ${humanSize(t.rawSize || 0)}` +
        ` · 诊断 <b>${c.error || 0}</b>/<b>${c.warning || 0}</b>/<b>${c.info || 0}</b>` +
        ` · ${escapeHtml(when)}`;
    } else {
      metaEl.textContent = "未保存（解析报文后点击“保存当前解析”）";
    }
    $("#btnSave" + S).disabled = !parseResult;
    $("#btnLoad" + S).disabled = !snap;
    $("#btnClear" + S).disabled = !snap;
  }
  $("#btnCompare").disabled = !(snapshots.a && snapshots.b);
  if (!(snapshots.a && snapshots.b)) $("#btnExportDiff").disabled = true;
}

function resetDiffView() {
  diffReport = null;
  $("#diffResult").innerHTML = "";
  $("#diffMeta").textContent = "";
  $("#btnExportDiff").disabled = true;
}

async function doCompare() {
  if (!snapshots.a || !snapshots.b) return;
  $("#btnCompare").disabled = true;
  try {
    const data = await postJSON("/api/diff", {
      a: { tree: snapshots.a.result.tree, issues: snapshots.a.result.issues || [] },
      b: { tree: snapshots.b.result.tree, issues: snapshots.b.result.issues || [] },
    });
    diffReport = data;
    renderDiff(data);
  } catch (e) {
    alert("对比失败：" + e.message);
  } finally {
    $("#btnCompare").disabled = false;
  }
}

// ------------------------------------------------------------ diff render --

function renderDiff(report) {
  const box = $("#diffResult");
  box.innerHTML = "";
  const s = report.summary || {};
  const total = (s.added || 0) + (s.removed || 0) + (s.modified || 0);
  $("#diffMeta").innerHTML =
    `样本 A <b>${escapeHtml(snapshots.a.result.mediaType || "—")}</b>` +
    ` vs 样本 B <b>${escapeHtml(snapshots.b.result.mediaType || "—")}</b>` +
    `　·　差异 <b>${total}</b> 处　·　未变节点 <b>${s.unchanged || 0}</b> 个`;

  const sum = document.createElement("div");
  sum.className = "diff-summary";
  sum.innerHTML =
    `<span class="chip diff-chip-added">新增 <b>${s.added || 0}</b></span>` +
    `<span class="chip diff-chip-removed">删除 <b>${s.removed || 0}</b></span>` +
    `<span class="chip diff-chip-modified">修改 <b>${s.modified || 0}</b></span>`;
  box.appendChild(sum);

  if (report.identical) {
    const ok = document.createElement("div");
    ok.className = "diff-identical";
    ok.textContent = "✅ 两份样本在比较维度上完全一致";
    box.appendChild(ok);
  }

  for (const kind of ["added", "removed", "modified"]) {
    const entries = (report.entries || []).filter((e) => e.kind === kind);
    if (entries.length) box.appendChild(diffGroup(kind, entries));
  }
  $("#btnExportDiff").disabled = false;
}

function diffGroup(kind, entries) {
  const g = document.createElement("div");
  g.className = `diff-group diff-${kind}`;
  const head = document.createElement("div");
  head.className = "diff-group-head";
  head.innerHTML =
    `<span class="caret">▼</span>` +
    `<span class="diff-kind-badge">${DIFF_KIND_LABEL[kind]}</span>` +
    `<span class="diff-count">${entries.length} 项</span>`;
  head.addEventListener("click", () => g.classList.toggle("collapsed"));
  const body = document.createElement("div");
  body.className = "diff-group-body";
  entries.forEach((e) => body.appendChild(diffEntry(e)));
  g.appendChild(head);
  g.appendChild(body);
  return g;
}

function diffEntry(e) {
  const div = document.createElement("div");
  div.className = "diff-entry";

  const head = document.createElement("div");
  head.className = "diff-entry-head";
  let mt;
  if (e.kind === "modified") {
    mt = e.mediaTypeA === e.mediaTypeB
      ? (e.mediaTypeA ?? "—")
      : `${e.mediaTypeA ?? "—"} → ${e.mediaTypeB ?? "—"}`;
  } else {
    mt = e.mediaType ?? e.nodeKind ?? "—";
  }
  let extra = "";
  if (e.kind !== "modified" && (e.nodeCount || 0) > 1) {
    extra += `<span class="meta-pill">含 ${e.nodeCount} 个节点</span>`;
  }
  if (e.name != null) extra += `<span class="meta-pill">name=${escapeHtml(e.name)}</span>`;
  if (e.filename != null) extra += `<span class="meta-pill">filename=${escapeHtml(e.filename)}</span>`;
  head.innerHTML =
    `<code class="diff-path">${escapeHtml(e.path)}</code>` +
    `<span class="diff-mt">${escapeHtml(mt)}</span>` + extra;

  const loc = document.createElement("span");
  loc.className = "diff-locate";
  const sides = e.kind === "added" ? ["b"] : e.kind === "removed" ? ["a"] : ["a", "b"];
  for (const side of sides) {
    const btn = document.createElement("button");
    btn.className = "btn btn-sm btn-ghost";
    btn.type = "button";
    btn.textContent = `定位 ${side.toUpperCase()}`;
    btn.title = `在样本 ${side.toUpperCase()} 的结构树中定位该节点`;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      locateNode(side, e.path);
    });
    loc.appendChild(btn);
  }
  head.appendChild(loc);
  div.appendChild(head);

  if (e.kind === "modified" && (e.changes || []).length) {
    const box = document.createElement("div");
    box.className = "diff-changes";
    e.changes.forEach((ch) => box.appendChild(diffChange(ch)));
    div.appendChild(box);
  }
  return div;
}

function fmtScalar(v) {
  if (v === null || v === undefined) return "（无）";
  if (v === "") return "（空）";
  if (typeof v === "boolean") return v ? "是" : "否";
  const s = String(v);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

function diffChange(ch) {
  const div = document.createElement("div");
  div.className = "diff-change";
  const label = DIFF_FIELD_LABEL[ch.field] || ch.field;

  if (ch.field === "headers") {
    const rows = [];
    for (const h of ch.removed || []) {
      rows.push(`<div class="dh removed">− ${escapeHtml(h.name)}: ${escapeHtml(h.values.join(" | "))}</div>`);
    }
    for (const h of ch.added || []) {
      rows.push(`<div class="dh added">+ ${escapeHtml(h.name)}: ${escapeHtml(h.values.join(" | "))}</div>`);
    }
    for (const h of ch.changed || []) {
      rows.push(
        `<div class="dh changed">~ ${escapeHtml(h.name)}: ` +
        `<span class="old">${escapeHtml(h.a.join(" | "))}</span> → ` +
        `<span class="new">${escapeHtml(h.b.join(" | "))}</span></div>`);
    }
    div.innerHTML =
      `<span class="diff-field">${escapeHtml(label)}</span>` +
      `<div class="dh-box">${rows.join("")}</div>`;
  } else if (ch.field === "issues") {
    const rows = [];
    for (const c of ch.removed || []) rows.push(`<div class="dh removed">− ${escapeHtml(c)}</div>`);
    for (const c of ch.added || []) rows.push(`<div class="dh added">+ ${escapeHtml(c)}</div>`);
    const fmt = (arr) => (arr && arr.length ? arr.map(escapeHtml).join(", ") : "无");
    div.innerHTML =
      `<span class="diff-field">${escapeHtml(label)}</span>` +
      `<div class="dh-box">${rows.join("")}</div>` +
      `<div class="dh muted">A：[${fmt(ch.a)}]　B：[${fmt(ch.b)}]</div>`;
  } else if (Object.prototype.hasOwnProperty.call(ch, "aPreview")) {
    div.innerHTML =
      `<span class="diff-field">${escapeHtml(label)}</span>` +
      `<div class="dh-box">` +
      `<div class="dh removed">A（${ch.aLength} 字符）：${escapeHtml(ch.aPreview ?? "（无）")}</div>` +
      `<div class="dh added">B（${ch.bLength} 字符）：${escapeHtml(ch.bPreview ?? "（无）")}</div>` +
      `</div>`;
  } else {
    div.innerHTML =
      `<span class="diff-field">${escapeHtml(label)}</span>` +
      `<code class="diff-val a">${escapeHtml(fmtScalar(ch.a))}</code>` +
      ` → <code class="diff-val b">${escapeHtml(fmtScalar(ch.b))}</code>`;
  }
  return div;
}

// ------------------------------------------------------------ diff locate --

function locateNode(side, path) {
  if (!snapshots[side]) return;
  // 编辑器当前不是该样本时先载入；已是该样本则保留用户的编辑状态
  if (editorSource !== side) loadSnapshotIntoEditor(side);
  const target = $$("#treeRoot .node").find((el) => el.dataset.path === path);
  if (!target) {
    alert(`当前编辑器中找不到节点 ${path}（结构可能已被编辑）`);
    return;
  }
  let p = target.parentElement;
  while (p && p.id !== "treeRoot") {
    if (p.classList && p.classList.contains("node")) p.classList.remove("collapsed");
    p = p.parentElement;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1800);
}

// ------------------------------------------------------------ diff export --

function exportDiff() {
  if (!diffReport) return;
  const payload = {
    tool: "mime-multipart-inspector",
    kind: "sample-diff-report",
    exportedAt: new Date().toISOString(),
    snapshots: { a: snapshotMeta("a"), b: snapshotMeta("b") },
    ...diffReport,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mime-diff-report.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------------------------------------------- init --

function init() {
  $("#btnParse").addEventListener("click", doParse);
  $("#btnEncode").addEventListener("click", () => doEncode(true));
  $("#btnDownload").addEventListener("click", downloadBlob);
  $("#btnCopy").addEventListener("click", copyOutput);
  $("#showOutput").addEventListener("change", (e) => {
    $("#outputPreview").classList.toggle("hidden", !e.target.checked);
  });
  $("#btnSampleBasic").addEventListener("click", () => {
    fillSample($("#rawInput"), SAMPLE_BASIC);
  });
  $("#btnSampleNested").addEventListener("click", () => {
    fillSample($("#rawInput"), SAMPLE_NESTED);
  });
  $("#btnSampleBad").addEventListener("click", () => {
    fillSample($("#rawInput"), SAMPLE_BAD);
  });
  $$(".issue-filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const lvl = chip.dataset.level;
      issueFilter[lvl] = !issueFilter[lvl];
      chip.classList.toggle("active", issueFilter[lvl]);
      if (parseResult) renderIssues($("#issuesList"), parseResult.issues);
    });
  });
  // 样本对比
  $("#btnSaveA").addEventListener("click", () => saveSnapshot("a"));
  $("#btnSaveB").addEventListener("click", () => saveSnapshot("b"));
  $("#btnLoadA").addEventListener("click", () => loadSnapshotIntoEditor("a"));
  $("#btnLoadB").addEventListener("click", () => loadSnapshotIntoEditor("b"));
  $("#btnClearA").addEventListener("click", () => clearSnapshot("a"));
  $("#btnClearB").addEventListener("click", () => clearSnapshot("b"));
  $("#btnCompare").addEventListener("click", doCompare);
  $("#btnExportDiff").addEventListener("click", exportDiff);
  restoreSnapshots();
  renderSnapSlots();
  // 默认载入表单示例，打开即可体验
  fillSample($("#rawInput"), SAMPLE_BASIC);
}

document.addEventListener("DOMContentLoaded", init);

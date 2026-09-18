/* MIME Multipart 检查器前端（无框架原生实现） */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let parseResult = null;       // 最近一次解析返回
let tree = null;              // 当前可编辑树（对象引用，控件直接改它）
let encodedBytes = null;      // Uint8Array 编码结果
const issueFilter = { error: true, warning: true, info: true };

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
  // 默认载入表单示例，打开即可体验
  fillSample($("#rawInput"), SAMPLE_BASIC);
}

document.addEventListener("DOMContentLoaded", init);

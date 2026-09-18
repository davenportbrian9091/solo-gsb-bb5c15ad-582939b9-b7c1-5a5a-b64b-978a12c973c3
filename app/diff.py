"""样本对比：按树路径对齐比较两份 /api/parse 结果。

输入为两份解析结果（tree + issues），输出新增 / 删除 / 修改三类条目：
* 节点类型、媒体类型、boundary、序言 / 尾注（含编码）、leadingCrlf；
* 头部（按字段名对齐，报告新增 / 删除 / 值变化）；
* 正文与正文编码（正文只保留截断预览与长度，避免差异报告过大）；
* 归属各节点的诊断代码（按 issue 消息中的路径前缀归属，无前缀的归 root）。

路径规则与前端 reindexPaths 一致：root、parts[0]、parts[0].parts[1] …
子部分按索引对齐；一侧多出的子树整体记为一条新增 / 删除条目。
"""

from __future__ import annotations

from collections import Counter

PREVIEW_LEN = 200


# --------------------------------------------------------------------------- #
# 路径与诊断归属
# --------------------------------------------------------------------------- #

def _child_path(parent_path: str, index: int) -> str:
    return f"parts[{index}]" if parent_path == "root" else f"{parent_path}.parts[{index}]"


def _parts_list(node) -> list:
    """容错地取子部分列表；非 list 的 parts 一律视为无子部分。"""
    parts = node.get("parts") if isinstance(node, dict) else None
    return parts if isinstance(parts, list) else []


def _walk(node, path, fn):
    fn(node, path)
    if isinstance(node, dict) and node.get("kind") == "multipart":
        for i, child in enumerate(_parts_list(node)):
            _walk(child, _child_path(path, i), fn)


def _tree_paths(tree) -> list[str]:
    paths: list[str] = []
    if isinstance(tree, dict):
        _walk(tree, "root", lambda _n, p: paths.append(p))
    return paths


def _attribute_issues(issues, paths: list[str]) -> dict[str, list[str]]:
    """把扁平 issue 列表按消息前缀（"<path>：..."）归属到节点路径。

    无法匹配任何路径的（如 LF_NORMALIZED 等顶层诊断）归到 root。
    """
    per_node: dict[str, list[str]] = {p: [] for p in paths}
    # 长路径优先，避免 "parts[0]" 抢占 "parts[0].parts[1]"
    ordered = sorted(paths, key=len, reverse=True)
    fallback = "root" if "root" in per_node else (paths[0] if paths else "root")
    for it in issues or []:
        msg = (it or {}).get("message") or ""
        code = (it or {}).get("code") or ""
        target = fallback
        for p in ordered:
            if msg.startswith(p + "："):
                target = p
                break
        per_node.setdefault(target, []).append(code)
    return per_node


# --------------------------------------------------------------------------- #
# 字段级比较
# --------------------------------------------------------------------------- #

def _preview(text) -> str | None:
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= PREVIEW_LEN else text[:PREVIEW_LEN] + "…"


def _scalar_change(changes: list[dict], field: str, a, b):
    if a != b:
        changes.append({"field": field, "a": a, "b": b})


def _text_change(changes: list[dict], field: str, a, b):
    a = a or ""
    b = b or ""
    if a != b:
        changes.append({
            "field": field,
            "aPreview": _preview(a),
            "bPreview": _preview(b),
            "aLength": len(a),
            "bLength": len(b),
        })


def _header_map(headers) -> dict[str, dict]:
    """字段名（小写）-> {name, values[]}，同名字段保留全部值。"""
    m: dict[str, dict] = {}
    for h in headers or []:
        name = str((h or {}).get("name") or "").strip()
        key = name.lower()
        entry = m.setdefault(key, {"name": name, "values": []})
        entry["values"].append(str((h or {}).get("value") or ""))
    return m


def _diff_headers(changes: list[dict], ha, hb):
    ma, mb = _header_map(ha), _header_map(hb)
    added = [{"name": mb[k]["name"], "values": mb[k]["values"]}
             for k in mb if k not in ma]
    removed = [{"name": ma[k]["name"], "values": ma[k]["values"]}
               for k in ma if k not in mb]
    changed = [{"name": ma[k]["name"], "a": ma[k]["values"], "b": mb[k]["values"]}
               for k in ma if k in mb and ma[k]["values"] != mb[k]["values"]]
    if added or removed or changed:
        changes.append({"field": "headers",
                        "added": added, "removed": removed, "changed": changed})


def _diff_issues(changes: list[dict], codes_a, codes_b):
    ca, cb = sorted(codes_a), sorted(codes_b)
    if ca == cb:
        return
    cnt_a, cnt_b = Counter(codes_a), Counter(codes_b)
    changes.append({
        "field": "issues",
        "a": ca,
        "b": cb,
        "added": sorted((cnt_b - cnt_a).elements()),
        "removed": sorted((cnt_a - cnt_b).elements()),
    })


# --------------------------------------------------------------------------- #
# 节点级比较
# --------------------------------------------------------------------------- #

def _subtree_entry(kind: str, node, path: str) -> dict:
    """整棵子树的新增 / 删除条目（附节点数与基本标识）。"""
    node = node if isinstance(node, dict) else {}
    count = 0

    def _cnt(n):
        nonlocal count
        count += 1
        for c in _parts_list(n):
            _cnt(c)

    _cnt(node)
    entry = {
        "kind": kind,
        "path": path,
        "nodeKind": node.get("kind"),
        "mediaType": node.get("mediaType"),
        "nodeCount": count,
    }
    if node.get("name") is not None:
        entry["name"] = node.get("name")
    if node.get("filename") is not None:
        entry["filename"] = node.get("filename")
    return entry


def _compare_node(a, b, path, codes_a, codes_b, entries, stats):
    a = a if isinstance(a, dict) else {}
    b = b if isinstance(b, dict) else {}
    ka, kb = a.get("kind"), b.get("kind")
    changes: list[dict] = []

    _scalar_change(changes, "kind", ka, kb)
    _scalar_change(changes, "mediaType", a.get("mediaType"), b.get("mediaType"))
    _diff_headers(changes, a.get("headers"), b.get("headers"))

    if ka == "multipart" or kb == "multipart":
        _scalar_change(changes, "boundary", a.get("boundary"), b.get("boundary"))
        _scalar_change(changes, "leadingCrlf",
                       a.get("leadingCrlf"), b.get("leadingCrlf"))
        _text_change(changes, "preamble", a.get("preamble"), b.get("preamble"))
        _scalar_change(changes, "preambleEncoding",
                       a.get("preambleEncoding"), b.get("preambleEncoding"))
        _text_change(changes, "epilogue", a.get("epilogue"), b.get("epilogue"))
        _scalar_change(changes, "epilogueEncoding",
                       a.get("epilogueEncoding"), b.get("epilogueEncoding"))

    if ka == "part" or kb == "part":
        _scalar_change(changes, "hasHeaders",
                       a.get("hasHeaders"), b.get("hasHeaders"))
        _scalar_change(changes, "bodyEncoding",
                       a.get("bodyEncoding"), b.get("bodyEncoding"))
        _text_change(changes, "body", a.get("body"), b.get("body"))

    _diff_issues(changes, codes_a.get(path, []), codes_b.get(path, []))

    if changes:
        entries.append({
            "kind": "modified",
            "path": path,
            "nodeKindA": ka,
            "nodeKindB": kb,
            "mediaTypeA": a.get("mediaType"),
            "mediaTypeB": b.get("mediaType"),
            "changes": changes,
        })
    else:
        stats["unchanged"] += 1

    # 双方同为 multipart 时按索引递归对齐子部分；多出的子树整体记新增 / 删除
    if ka == "multipart" and kb == "multipart":
        pa, pb = _parts_list(a), _parts_list(b)
        common = min(len(pa), len(pb))
        for i in range(common):
            _compare_node(pa[i], pb[i], _child_path(path, i),
                          codes_a, codes_b, entries, stats)
        for i in range(common, len(pa)):
            entries.append(_subtree_entry("removed", pa[i], _child_path(path, i)))
        for i in range(common, len(pb)):
            entries.append(_subtree_entry("added", pb[i], _child_path(path, i)))


def compare_results(tree_a, issues_a, tree_b, issues_b) -> dict:
    """比较两份解析结果，返回差异报告（新增 / 删除 / 修改 + 汇总）。"""
    entries: list[dict] = []
    stats = {"unchanged": 0}
    codes_a = _attribute_issues(issues_a, _tree_paths(tree_a))
    codes_b = _attribute_issues(issues_b, _tree_paths(tree_b))
    _compare_node(tree_a, tree_b, "root", codes_a, codes_b, entries, stats)
    summary = {
        "added": sum(1 for e in entries if e["kind"] == "added"),
        "removed": sum(1 for e in entries if e["kind"] == "removed"),
        "modified": sum(1 for e in entries if e["kind"] == "modified"),
        "unchanged": stats["unchanged"],
    }
    return {
        "ok": True,
        "identical": not entries,
        "summary": summary,
        "entries": entries,
    }

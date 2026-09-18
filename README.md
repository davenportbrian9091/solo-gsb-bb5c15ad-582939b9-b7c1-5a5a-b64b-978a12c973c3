# MIME Multipart 报文检查器

基于 **FastAPI + 原生 HTML/CSS/JavaScript** 的 MIME `multipart/*` 报文解析、
查看、编辑与重新编码工具。严格按 **RFC 2045 / 2046** 处理：

- 🔍 **解析**：粘贴 `Content-Type`、`boundary` 和原始报文，自动识别
  *完整 MIME 报文*（含顶层头部）或 *仅 multipart body*；
- 🪆 **嵌套 multipart**：递归解析 `multipart/mixed`、`multipart/alternative`、
  `multipart/form-data` 等任意 `multipart/*`；
- 📐 **CRLF 边界**：识别 `CRLF "--boundary"` 起始定界符与
  `"--boundary--"` 关闭定界符，校验 transport padding、preamble/epilogue、
  缺关闭定界符、报文截断等；
- 📝 **引号参数**：正确解析 Content-Type 中带引号的 `boundary` 参数、
  分号与反斜杠转义（如 `boundary="a;b"`、`charset="utf\"-8"`）；
- 🩺 **诊断面板**：按 *错误 / 警告 / 提示* 三级列出每个解析问题及所属部分路径；
- ✏️ **可视化编辑**：逐层展开/折叠，编辑任意部分的头部、正文、boundary、
  preamble / epilogue，可新增或删除部分；
- 🔁 **重新编码并下载**：按（可能已修改的）boundary 规则以 CRLF 重新生成报文，
  可选择是否包含顶层头部；未修改的部分逐字节还原（含二进制）。

---

## 快速开始（Docker）

```bash
docker compose up --build
```

启动后用浏览器访问：

> **http://localhost:8000**

停止：

```bash
docker compose down
```

## 不使用 Compose（docker）

```bash
docker build -t mime-inspector .
docker run --rm -p 8000:8000 mime-inspector
# 浏览器打开 http://localhost:8000
```

## 本地开发（Python 3.11+）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

访问 http://localhost:8000 ；交互式 API 文档在
http://localhost:8000/docs 。

---

## 使用说明

1. 在顶部选择一个内置示例（**表单 / 嵌套 / 错误报文**），或直接粘贴：
   - **Content-Type**（可选）：例如
     `multipart/form-data; boundary="----xyz"`；留空则从报文头部读取；
   - **boundary**（可选）：单独填写，会覆盖 Content-Type 中的参数（可带引号）；
   - **原始报文**：完整 MIME 报文或 multipart body 均可，支持 CRLF / LF。
2. 点击 **解析报文**，查看诊断信息与树形结构。
3. 展开任意 multipart 节点，修改 boundary、头部、正文、preamble/epilogue，
   或增删子部分。
4. 勾选/取消“编码时包含顶层头部”，点击 **重新编码并下载**。
5. 在结果区可重新下载、复制为文本，或查看编码后的完整报文。

> 不是合法 UTF-8 的正文（如二进制附件）会以 **base64** 呈现；只要不修改，
> 重新编码时会逐字节还原。

---

## 解析规则与诊断代码

解析器采用“尽量恢复、绝不轻易失败”的策略：能继续解析的问题记录为 issue，
而不是中断。常见诊断：

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `NO_DELIMITER` | 错误 | 正文中找不到任何 `--boundary` |
| `MISSING_CLOSE_DELIMITER` | 错误 | 缺少 `--boundary--`，报文可能被截断 |
| `TRUNCATED_PART` | 错误 | 某部分之后缺少结束该部分的 CRLF |
| `BAD_DELIMITER` | 错误 | 定界符后存在非法字符，或出现碰撞文本 |
| `MISSING_BOUNDARY` | 错误 | `multipart/*` 的 Content-Type 无 boundary 参数 |
| `BOUNDARY_COLLISION` | 错误 | （编码时）正文行首出现本层定界符，会截断报文 |
| `BAD_HEADER_LINE` / `BAD_HEADER_NAME` | 错误 | 头部缺少冒号 / 字段名非法 |
| `BAD_QUOTED_STRING` / `BAD_PARAM_SYNTAX` | 错误 | 引号未闭合 / 参数语法错误 |
| `LF_NORMALIZED` | 警告 | 输入含孤立 LF/CR，已规范化为 CRLF |
| `BOUNDARY_NONCOMPLIANT` | 警告 | boundary 超过 70 字符或含非法字符 |
| `BOUNDARY_OVERRIDE` | 警告 | 输入框/Content-Type 中的 boundary 不一致 |
| `TRAILING_PADDING` | 警告 | 定界符后存在 transport padding 空白 |
| `NO_LEADING_CRLF` | 提示 | 首定界符前无 CRLF（HTTP multipart 常见） |
| `PREAMBLE` / `EPILOGUE` | 提示 | 存在序言 / 尾注，MIME 处理器应忽略 |
| `BINARY_BODY` | 提示 | 该部分为非文本，已按 base64 呈现 |

---

## HTTP API

### `POST /api/parse`

请求：

```json
{
  "raw": "Content-Type: multipart/form-data; boundary=B\r\n\r\n--B\r\n\r\nv\r\n--B--",
  "rawBase64": "...(可选，二进制无损通道，优先于 raw)...",
  "contentType": "multipart/form-data; boundary=B",
  "boundary": "B"
}
```

响应（节选）：

```json
{
  "ok": true,
  "mediaType": "multipart/form-data",
  "effectiveBoundary": "B",
  "hasTopHeaders": true,
  "counts": { "error": 0, "warning": 0, "info": 0 },
  "issues": [ { "level": "warning", "code": "LF_NORMALIZED", "message": "..." } ],
  "tree": {
    "kind": "multipart",
    "mediaType": "multipart/form-data",
    "boundary": "B",
    "leadingCrlf": false,
    "headers": [ { "name": "Content-Type", "value": "..." } ],
    "preamble": "", "preambleEncoding": "utf-8",
    "epilogue": "", "epilogueEncoding": "utf-8",
    "parts": [ {
      "kind": "part",
      "mediaType": "text/plain",
      "headers": [],
      "hasHeaders": false,
      "body": "v",
      "bodyEncoding": "utf-8"
    } ]
  }
}
```

### `POST /api/encode`

请求：

```json
{ "tree": { /* /api/parse 返回的 tree，可修改 */ }, "includeHeaders": true }
```

响应：

```json
{
  "ok": true,
  "payloadBase64": "Q29udGVudC1UeXBlOi...",
  "size": 123,
  "lineEnding": "CRLF",
  "counts": { "error": 0, "warning": 0, "info": 0 },
  "issues": []
}
```

### `GET /api/health`

返回 `{"ok": true}`，供容器健康检查使用。

---

## 项目结构

```
.
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI 应用、/api/parse、/api/encode、静态文件
│   ├── mime.py              # 零第三方依赖的 MIME 解析 / 重新编码核心
│   └── static/
│       ├── index.html       # 页面结构
│       ├── styles.css       # 深色主题样式
│       └── app.js           # 原生 JS：示例、树形编辑器、下载
├── tests/
│   └── smoke_test.py        # 解析/编码端到端测试（仅需 Python 标准库）
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 运行测试

测试不依赖 FastAPI，只用 Python 标准库：

```bash
python3 tests/smoke_test.py
```

覆盖：基本 form-data、CJK、嵌套 multipart、preamble/epilogue、
引号与转义参数、boundary 覆盖、定界符碰撞、缺关闭定界符、LF 规范化、
二进制逐字节往返、编辑后重新编码等。

---

## 安全说明

- 该工具用于**本地检查报文**，默认只监听容器的 `8000` 端口；请勿直接暴露到公网。
- 所有解析都在内存中完成，请求不会转发到任何第三方。
- 二进制正文以 base64 在前后端之间传输，避免编码损坏。

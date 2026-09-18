"""端到端冒烟测试：不依赖第三方库，直接调用 mime.py。"""
import base64
import sys

sys.path.insert(0, ".")
from app import mime

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def roundtrip(raw_b, **kw):
    """raw_b 为 bytes；按 UTF-8 解码成 JSON 文本后传入（模拟浏览器）。"""
    r = mime.parse_message(raw_b.decode("utf-8"), kw.get("ct"), kw.get("boundary"))
    assert r["ok"], r
    enc = mime.encode_tree(r["tree"], include_headers=kw.get("include_headers", True))
    assert enc["ok"], enc["issues"]
    return r, enc, base64.b64decode(enc["payloadBase64"])


# 1. 基本 multipart/form-data，含 CJK 与 quoted boundary --------------------
print("1) 基本 form-data 往返")
raw = (
    b'Content-Type: multipart/form-data; boundary="----B"\r\n'
    b'\r\n'
    b'------B\r\n'
    b'Content-Disposition: form-data; name="u"\r\n'
    b'\r\n'
    b'alice\r\n'
    b'------B\r\n'
    b'Content-Disposition: form-data; name="bio"\r\n'
    b'\r\n'
    + "你好".encode() + b'\r\n'
    b'------B--'
)
r, enc, out = roundtrip(raw)
check("顶层是 multipart", r["tree"]["kind"] == "multipart")
check("2 个子部分", len(r["tree"]["parts"]) == 2)
check("boundary 去引号生效", r["effectiveBoundary"] == "----B")
check("part name 解析", r["tree"]["parts"][0]["name"] == "u")
check("CJK 往返", "你好".encode() in out)
check("无 error", r["counts"]["error"] == 0, r["issues"])
check("重新编码包含关闭定界符", b"------B--" in out)
# 参数引号会被规范化（合法 token 去引号），故比较规范化后的形式
canonical_raw = raw.replace(b'boundary="----B"', b"boundary=----B")
check("字节级往返一致（参数引号规范化）", out == canonical_raw,
      f"\n{out!r}\n!=\n{canonical_raw!r}")

# 2. 嵌套 multipart（含 preamble / epilogue） -------------------------------
print("2) 嵌套 multipart")
raw2 = (
    b'Content-Type: multipart/mixed; boundary=OUTER\r\n\r\n'
    b'preamble text\r\n'
    b'--OUTER\r\n'
    b'Content-Type: text/plain\r\n\r\n'
    b'outer body\r\n'
    b'--OUTER\r\n'
    b'Content-Type: multipart/alternative; boundary="INNER42"\r\n\r\n'
    b'nested preamble\r\n'
    b'--INNER42\r\nContent-Type: text/plain\r\n\r\nplain\r\n'
    b'--INNER42\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n'
    b'--INNER42--\r\n'
    b'--OUTER\r\nContent-Type: text/csv\r\n\r\na,b\r\n1,2\r\n'
    b'--OUTER--\r\n'
    b'epi'
)
r2, enc2, out2 = roundtrip(raw2)
t = r2["tree"]
check("3 个外层部分", len(t["parts"]) == 3, [(p["kind"], p.get("mediaType")) for p in t["parts"]])
nested = t["parts"][1]
check("第 2 部分识别为嵌套 multipart", nested["kind"] == "multipart"
      and nested["mediaType"] == "multipart/alternative")
check("嵌套 2 部分", len(nested["parts"]) == 2)
check("preamble 保留", "preamble text" in t["preamble"])
check("嵌套 preamble 保留", "nested preamble" in nested["preamble"])
check("epilogue 保留", t["epilogue"] == "epi", repr(t["epilogue"]))
check("嵌套往返一致", out2 == raw2.replace(b'boundary="INNER42"', b"boundary=INNER42"),
      f"\n{out2!r}\n!=\n{raw2!r}")
check("嵌套无 error", r2["counts"]["error"] == 0,
      [i for i in r2["issues"] if i["level"] == "error"])

# 3. LF 规范化 + 缺关闭定界符 + 畸形 header ---------------------------------
print("3) 错误报文诊断")
raw3 = (
    b'Content-Type: multipart/form-data; boundary=X\n'
    b'\n'
    b'--X\nContent-Disposition: form-data; name="ok"\n\ngood\n'
    b'--X\nBroken Header Line no colon\n\nrest'
)
r3 = mime.parse_message(raw3.decode(), None, None)
codes = [i["code"] for i in r3["issues"]]
check("检测到 LF 规范化", "LF_NORMALIZED" in codes, codes)
# 首行不是合法字段 => 该部分无有效头部块
check("畸形头部报错", "NO_HEADER_BODY_SEPARATOR" in codes, codes)
check("缺少关闭定界符报错", "MISSING_CLOSE_DELIMITER" in codes, codes)

# 3b. 首行合法、次行畸形 -> BAD_HEADER_LINE
raw3b = (
    b"Content-Type: multipart/mixed; boundary=Y\r\n\r\n"
    b"--Y\r\nGood-Header: yes\r\nbroken line without colon\r\n\r\nbody\r\n--Y--"
)
r3b = mime.parse_message(raw3b.decode(), None, None)
check("首行合法时次行畸形报 BAD_HEADER_LINE",
      any(i["code"] == "BAD_HEADER_LINE" for i in r3b["issues"]),
      [i["code"] for i in r3b["issues"]])
check("仍尽力恢复 2 个部分", len(r3["tree"]["parts"]) == 2)
enc3 = mime.encode_tree(r3["tree"], include_headers=True)
check("重新编码总是生成关闭定界符",
      b"--X--" in base64.b64decode(enc3["payloadBase64"]))

# 4. boundary 输入框覆盖 + body-only ----------------------------------------
print("4) boundary 覆盖与无头部 body")
body_only = b"--CUSTOM\r\nContent-Type: text/plain\r\n\r\nv\r\n--CUSTOM--"
r4 = mime.parse_message(body_only.decode(), None, "CUSTOM")
check("无顶层头部按 body 解析", r4["hasTopHeaders"] is False)
check("输入框 boundary 生效", r4["effectiveBoundary"] == "CUSTOM")
check("无 error", r4["counts"]["error"] == 0, r4["issues"])
enc4 = mime.encode_tree(r4["tree"], include_headers=False)
out4 = base64.b64decode(enc4["payloadBase64"])
check("仅输出 body 时不含顶层头部", not out4.startswith(b"Content-Type"), out4[:60])
check("body-only 往返一致", out4 == body_only, f"\n{out4!r}\n!=\n{body_only!r}")

# 5. quoted 参数带转义 ------------------------------------------------------
print("5) quoted-string 参数解析")
issues5 = []
mt, p = mime.parse_content_type(
    'multipart/form-data; boundary="ABC.123_-"; charset="utf\\"-8"; x=tok',
    issues5)
check("quoted boundary 保留", p.get("boundary") == "ABC.123_-", p)
check("反斜杠转义引号", p.get("charset") == 'utf"-8', p)
check("普通 token 参数", p.get("x") == "tok")
check("无解析 issue", issues5 == [], issues5)

# 6. 边界碰撞：正文中的 "--Z" 不在行首或无 CRLF 后缀 ------------------------
print("6) 正文中包含类似 boundary 的文本")
body6 = (
    b"--Z\r\nContent-Type: text/plain\r\n\r\nfake --Zline\r\n--Z\r\n"
    b"Content-Type: text/plain\r\n\r\nsecond\r\n--Z--"
)
r6 = mime.parse_message(body6.decode(), "multipart/mixed", "Z")
check("碰撞文本未被误判为定界符", len(r6["tree"]["parts"]) == 2,
      [i["message"] for i in r6["issues"]])
check("第一部分正文完整", r6["tree"]["parts"][0]["body"] == "fake --Zline")
check("碰撞无 error", r6["counts"]["error"] == 0, r6["issues"])

# 7. 修改后再编码 -----------------------------------------------------------
print("7) 编辑后重新编码")
r7 = mime.parse_message(raw.decode(), None, None)
r7["tree"]["parts"][0]["body"] = "bob"
r7["tree"]["boundary"] = "NEW-B"
enc7 = mime.encode_tree(r7["tree"], include_headers=True)
out7 = base64.b64decode(enc7["payloadBase64"])
check("使用新 boundary", b"--NEW-B\r\n" in out7 and b"--NEW-B--" in out7)
check("Content-Type 头 boundary 同步", b"boundary=NEW-B" in out7, out7[:120])
check("正文更新", b"\r\nbob\r\n--NEW-B" in out7)
check("旧 boundary 不再出现", b"----B" not in out7)

# 8. 非 UTF-8 二进制正文逐字节保持 ------------------------------------------
print("8) 非 UTF-8 正文逐字节保持")
binary = bytes(range(1, 256))
raw8 = (b"Content-Type: multipart/mixed; boundary=BIN\r\n\r\n"
        b"--BIN\r\n\r\n" + binary + b"\r\n--BIN--")
r8 = mime.parse_message(None, None, None, raw_base64=base64.b64encode(raw8).decode())
check("二进制正文标记 base64", r8["tree"]["parts"][0]["bodyEncoding"] == "base64")
# 无头部部分：分隔定界符行后的前导 CRLF 是正文的一部分
check("base64 载荷正确", base64.b64decode(r8["tree"]["parts"][0]["body"]) == b"\r\n" + binary)
enc8 = mime.encode_tree(r8["tree"], True)
out8 = base64.b64decode(enc8["payloadBase64"])
check("二进制字节级往返", out8 == raw8, "二进制损坏")

# 9. 异常输入不崩溃 ---------------------------------------------------------
print("9) 异常输入不崩溃")
r9 = mime.parse_message("garbage without delimiters", "multipart/mixed", "NOPE")
check("找不到定界符报错且不崩", any(i["code"] == "NO_DELIMITER" for i in r9["issues"]))
r10 = mime.parse_message("", None, None)
check("空输入返回结构", "tree" in r10 or r10.get("ok") is False)

# 10. body 无头部、有 preamble 的 body-only ---------------------------------
print("10) 仅 body 且带 preamble")
raw10 = b"hi this is preamble\r\n--P\r\n\r\nbody\r\n--P--\r\ntail"
r10p = mime.parse_message(raw10.decode(), "multipart/mixed", "P")
check("preamble 识别", r10p["tree"]["preamble"] == "hi this is preamble",
      repr(r10p["tree"]["preamble"]))
check("epilogue 识别", r10p["tree"]["epilogue"] == "tail", repr(r10p["tree"]["epilogue"]))
enc10 = mime.encode_tree(r10p["tree"], include_headers=False)
out10 = base64.b64decode(enc10["payloadBase64"])
check("body-only 带序言往返", out10 == raw10, f"\n{out10!r}\n!=\n{raw10!r}")

print(f"\n结果: {PASS} 通过, {FAIL} 失败")
sys.exit(1 if FAIL else 0)

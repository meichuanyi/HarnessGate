#!/usr/bin/env python3
"""HarnessGate 前端回归测试（真实浏览器）

覆盖：三级导航（Harness 总览 → 会话列表 → 对话）、发消息收回复、
输入框不被状态更新冲掉、会话标题回填、从历史会话回放台账。

    python3 tests/ui.py            # 需要 pip install playwright && playwright install chromium
    HG_URL=http://host:9830/ python3 tests/ui.py
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("HG_URL", "http://localhost:9830/")
HARNESS = os.environ.get("HG_HARNESS", "opencode")
CWD = os.environ.get("HG_TEST_CWD", "/tmp/hg-ui-test")

failures = []


def check(name, ok, extra=""):
    print(("✔ " if ok else "✘ ") + name + (f"  {extra}" if extra else ""))
    if not ok:
        failures.append(name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 940})
        errors, dialogs = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_function("document.getElementById('conn').textContent.includes('已连接')", timeout=15_000)
        page.wait_for_timeout(800)

        cards = page.eval_on_selector_all(".card", "e=>e.length")
        check("Harness 总览渲染出卡片", cards > 0, f"{cards} 张")

        page.click(f".card[data-h='{HARNESS}']")
        page.wait_for_timeout(500)
        check("点击 harness 进入会话列表", HARNESS.lower() in page.inner_text(".toolbar .ttl").lower())

        # 工作目录补全：输入即列目录、键盘选择补全、不存在时提示可创建
        page.click("#newCwd")
        page.fill("#newCwd", "/root/proj")
        page.wait_for_selector(".aclist .it", timeout=5_000)
        names = page.eval_on_selector_all(".aclist .it .nm", "e=>e.map(x=>x.innerText)")
        check("目录补全：输入片段列出候选", any("projects" in n for n in names), str(names[:4]))
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(150)
        check("目录补全：↓ 高亮候选项", page.eval_on_selector_all(".aclist .it.on", "e=>e.length") == 1)
        page.keyboard.press("Tab")
        page.wait_for_timeout(600)
        filled = page.eval_on_selector("#newCwd", "e=>e.value")
        check("目录补全：Tab 补全进输入框", filled == "/root/projects/", repr(filled))
        page.fill("#newCwd", "/root/hg-not-exist-xyz/sub")
        page.wait_for_timeout(600)
        hint = page.inner_text(".aclist .ft")
        check("目录补全：不存在的路径提示可创建", "不存在" in hint and "创建" in hint, hint)
        page.keyboard.press("Escape")
        page.wait_for_timeout(150)
        check("目录补全：Esc 关闭下拉", page.eval_on_selector(".aclist", "e=>e.hidden"))

        page.fill("#newCwd", CWD)
        page.keyboard.press("Escape")  # 关掉补全下拉，避免挡住按钮
        page.click("#startBtn")
        page.wait_for_function("!!document.getElementById('stream')", timeout=60_000)
        check("新建会话后自动进入对话视图", True)
        page.wait_for_function(
            "document.getElementById('chatHead').innerText.includes('运行中')", timeout=120_000
        )
        check("会话进入运行中", True)

        page.fill("#input", "只回复两个字：收到")
        page.click("#sendBtn")
        page.wait_for_function(
            "Array.from(document.querySelectorAll('#stream .msg:not(.user):not(.thought)'))"
            ".some(e=>e.innerText.includes('收到'))",
            timeout=120_000,
        )
        check("消息发送并收到回复", True)
        check("输入框已清空", page.eval_on_selector("#input", "e=>e.value") == "")

        page.evaluate(f"navHarness('{HARNESS}')")   # 面包屑：回到会话列表
        page.wait_for_timeout(800)
        titles = page.eval_on_selector_all(".row .t1", "e=>e.map(x=>x.innerText)")
        check("会话列表回填了会话标题", any("收到" in t for t in titles), str(titles[:2]))

        page.click(".row")
        page.wait_for_timeout(1500)
        msgs = page.eval_on_selector_all("#stream .msg", "e=>e.length")
        check("从历史会话进入对话并回放台账", msgs >= 2, f"{msgs} 条")

        cfgs = page.eval_on_selector_all("#cfg .cfgw", "e=>e.map(x=>x.innerText.replace(/\\n/g,' '))")
        check("顶栏出现会话级配置（模型等）", len(cfgs) > 0, str(cfgs[:1]))

        check("无 JS 报错", not errors, str(errors[:2]))
        check("无意外弹窗", not dialogs, str(dialogs[:2]))

        # 清理：回到会话列表删掉本次测试建的会话（顺带覆盖删除功能；这一步会有确认框）
        page.evaluate(f"navHarness('{HARNESS}')")
        page.wait_for_timeout(600)
        before = page.eval_on_selector_all(".row", "e=>e.length")
        page.click(".row button[data-act='del']")
        page.wait_for_timeout(900)
        after = page.eval_on_selector_all(".row", "e=>e.length")
        check("删除会话", after == before - 1, f"{before} → {after}")

        shot = os.environ.get("HG_SHOT", "/tmp/hg-ui-final.png")
        page.screenshot(path=shot)
        print(f"\n截图: {shot}")
        browser.close()

    print(f"\n=== {'PASS' if not failures else 'FAIL'} ===")
    return 0 if not failures else 1


sys.exit(main())

#!/usr/bin/env python3
"""圆桌界面回归测试（真实浏览器）

覆盖：三步向导（选目录 → 选 harness + 指定主持人 → 写议题 + 发言方式）、
按轮次纵向布局（开场 → 第1轮分栏 → 小结 → 第2轮分栏 → 最终总结）、
轮内分栏流式输出、主持人小结插在轮次之间。

    python3 tests/roundtable_ui.py
    HG_URL=http://host:9830/ python3 tests/roundtable_ui.py
"""
import os
from playwright.sync_api import sync_playwright
import sys
URL = os.environ.get("HG_URL", "http://localhost:9830/")
CWD = os.environ.get("HG_TEST_CWD", "/tmp/hg-rt6")
fails=[]
def check(n,ok,extra=""):
    print(("✔ " if ok else "✘ ")+n+(f"  {extra}" if extra else ""))
    if not ok: fails.append(n)

with sync_playwright() as p:
    b=p.chromium.launch(); page=b.new_page(viewport={"width":1600,"height":1000})
    errs=[]
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}") if m.type=="error" else None)
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_function("document.getElementById('conn').textContent.includes('已连接')", timeout=15000)
    page.wait_for_timeout(700)
    page.click("#roomBtn"); page.wait_for_timeout(500)
    page.fill("#rtCwd", CWD); page.wait_for_timeout(400)
    page.click("#rtNext1"); page.wait_for_timeout(400)
    page.click(".pick[data-h='zcode']"); page.wait_for_timeout(150)
    page.click(".pick[data-h='hermes']"); page.wait_for_timeout(150)
    page.select_option("#rtHost", "zcode"); page.wait_for_timeout(400)
    # 成员配置（模型等）：探活收集到的 configOptions 要在建会话前可改
    check("第 2 步：出现成员配置区", page.query_selector(".memberCfg") is not None)
    cfgsel = page.eval_on_selector_all(".memberCfg select[data-mcfg]", "e=>e.map(x=>x.dataset.mcfg+':'+x.dataset.cfg)")
    check("第 2 步：有可切换的配置下拉", len(cfgsel) > 0, str(cfgsel[:6]))
    if any(x.endswith(":model") for x in cfgsel):
        hid = next(x.split(":")[0] for x in cfgsel if x.endswith(":model"))
        n = page.eval_on_selector_all(f"select[data-mcfg='{hid}'][data-cfg='model'] option", "e=>e.length")
        check("第 2 步：模型选项已填充", n > 0, f"{hid} {n} 个")
        page.select_option(f"select[data-mcfg='{hid}'][data-cfg='model']", index=0)
        page.click("#rtNext2"); page.wait_for_timeout(300)
        check("第 3 步：回显已配成员", "已配" in page.inner_text(".rtCard"))
        page.click("#rtBack3"); page.wait_for_timeout(300)
        check("第 2 步：返回后选择被记住",
              page.eval_on_selector(f"select[data-mcfg='{hid}'][data-cfg='model']", "e=>e.selectedIndex") == 0)
    page.click("#rtNext2"); page.wait_for_timeout(400)
    page.fill("#rtTopic", "给一个 CLI 工具起名字，越怪越好")
    page.select_option("#rtRounds", "2")   # 最多轮数是下拉（含无上限）；共识即停开着也可能 2 轮就收敛
    page.click("#rtGo")
    page.wait_for_selector("#rtBlocks", timeout=20000)

    # 结构：应有 2 个轮次区块，每块内含 2 栏
    page.wait_for_function("document.querySelectorAll('.rtRound').length>=2", timeout=20000)
    check("按轮次纵向排列：2 个轮次区块", page.eval_on_selector_all(".rtRound","e=>e.length")==2)
    check("每轮内分栏：第1轮 2 栏", page.eval_on_selector_all(".rtRound[data-round='1'] .rtCol","e=>e.length")==2)
    check("第2轮初始为等待态", "pending" in (page.get_attribute(".rtRound[data-round='2']","class") or ""))

    # 主持人开场块
    page.wait_for_function("document.querySelectorAll('.rtHostBlock').length>=1", timeout=120000)
    check("主持人开场块出现", True)
    page.wait_for_function("document.querySelectorAll('.rtHostBlock').length>=1", timeout=120000)

    # 流式：第 1 轮某一栏应出现 rtLive（data-live 带 "1:" 前缀）
    page.wait_for_function(
        "Array.from(document.querySelectorAll(\".rtLive[data-live^='1:']\")).some(e=>!e.hidden)", timeout=120000)
    check("第 1 轮栏内出现流式输出", True)

    # 等第 1 轮结束、第 2 轮开始
    page.wait_for_function(
        "Array.from(document.querySelectorAll(\".rtLive[data-live^='2:']\")).some(e=>!e.hidden)", timeout=300000)
    check("第 2 轮栏内也出现流式输出", True)
    check("第 1 轮已完成（不再是 active）", "active" not in (page.get_attribute(".rtRound[data-round='1']","class") or ""))

    # 轮间小结块
    page.wait_for_function("document.querySelectorAll('.rtHostBlock').length>=2", timeout=200000)
    labels = page.eval_on_selector_all(".rtHostBlock .rn","e=>e.map(x=>x.innerText)")
    check("主持人小结插在轮次之间", any("小结" in l for l in labels), str(labels))

    # 整场结束
    page.wait_for_function("document.querySelector('.rtHead .pill').innerText.includes('完成')", timeout=400000)
    check("整场跑完", True)
    page.wait_for_timeout(1000)
    r1 = page.eval_on_selector_all(".rtRound[data-round='1'] .rtColBody .rtTurn","e=>e.length")
    r2 = page.eval_on_selector_all(".rtRound[data-round='2'] .rtColBody .rtTurn","e=>e.length")
    check("第1轮发言落到各自栏", r1>=2, f"{r1} 条")
    check("第2轮发言落到各自栏", r2>=2, f"{r2} 条")
    final = page.eval_on_selector_all(".rtHostBlock .rn","e=>e.map(x=>x.innerText)")
    check("最终总结块存在", any("最终" in l for l in final), str(final))
    check("无 JS 报错", not errs, str(errs[:2]))
    page.screenshot(path="/tmp/rt6.png", full_page=True)
    b.close()

print("\n=== "+("PASS" if not fails else f"FAIL: {fails}")+" ===")
sys.exit(1 if fails else 0)

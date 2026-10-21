#!/usr/bin/env python3
"""
对照实验：deepseek-v4.1-flash 在 Codex 风格多轮工具历史下是否更易跑飞。
变量：历史助手回合的 reasoning_content（full / missing / space）× reasoning_effort（medium / high）。
输出：每次运行一行 JSONL；跑飞判定 = 压缩比过低（重复）或触顶 max_tokens。
用法：
  python3 loop_experiment.py --dry-run
  CPS_KEY=... python3 loop_experiment.py --smoke
  CPS_KEY=... python3 loop_experiment.py --runs 30 --out results.jsonl
"""
import argparse, json, os, random, sys, threading, time, urllib.request, zlib, collections
from concurrent.futures import ThreadPoolExecutor

URL = os.environ.get('CPS_URL', 'http://127.0.0.1:3124/v1/chat/completions')
MODEL = os.environ.get('CPS_MODEL', 'pc/deepseek-v4.1-flash')
MAX_TOKENS = 8000
ABORT_CHARS = 30000          # 流式累计超过这个字符数仍未结束 → 判触顶（约等于 8000 token 上限）

TOOLS = [
    {"type": "function", "function": {"name": "shell", "description": "Run a shell command and return stdout.",
     "parameters": {"type": "object", "properties": {"command": {"type": "array", "items": {"type": "string"}}}, "required": ["command"]}}},
    {"type": "function", "function": {"name": "apply_patch", "description": "Create or edit a file using a patch.",
     "parameters": {"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]}}},
]

SYSTEM = ("You are a coding agent running in the Codex CLI. You can read files with the shell tool and "
          "create or edit files with the apply_patch tool. Work autonomously until the task is solved. "
          "When writing a file, write the complete file in one apply_patch call.")

REASON_BANK = [
    "The user wants the engine refactored. I should first look at how the module is laid out so I do not break the public API. Let me read the next chunk of the file and see which helpers it depends on.",
    "This chunk defines the scheduler queue. It keeps a priority map and a retry counter. I need to remember that the retry counter is reset on success, which matters for the rewrite.",
    "Now I see the error handling path. It wraps every task in try/catch and pushes failures to a dead-letter list. I should preserve that behaviour and the log format.",
    "The config loader merges defaults with environment overrides. There is a subtle ordering issue: env wins over file. I will keep that exactly as is.",
    "Next I want to check the metrics section, since the refactor must keep the counter names stable for the dashboards. Reading it now.",
    "This part exposes a small event emitter. Listeners are stored in a Map keyed by event name. Nothing surprising, but I should keep the once() semantics intact.",
    "I have enough context about the lifecycle hooks. Before writing anything, I will skim the remaining helper functions to make sure there are no hidden side effects.",
    "The utility section has pure functions only. Good, those can be moved verbatim. Let me read the tail of the file to see the exports.",
]

def gen_code(seed, i, lines=70):
    rnd = random.Random(seed * 1000 + i)
    out = []
    for n in range(lines):
        a, b = rnd.choice(['queue', 'task', 'retry', 'meta', 'emit', 'hook', 'conf', 'stat']), rnd.randint(1, 99)
        k = rnd.randint(0, 4)
        if k == 0: out.append(f"export function {a}{b}(ctx, opts = {{}}) {{")
        elif k == 1: out.append(f"  const {a}_{b} = ctx.{a}?.get({b}) ?? opts.{a} ?? null;")
        elif k == 2: out.append(f"  if (!{a}_{b}) throw new Error('missing {a} {b}');")
        elif k == 3: out.append(f"  ctx.stats.inc('{a}.{b}', {rnd.randint(1, 9)});")
        else: out.append("}")
    return "\n".join(out)

def build_messages(seed, history_mode, rounds=24):
    rnd = random.Random(seed)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Refactor src/engine{seed}.js into a cleaner structure: split it into small helpers but keep every exported function name. "
                                         "Read the whole file first, then write the new complete file to src/engine_new.js."}]
    for i in range(rounds):
        call_id = f"call_{seed}_{i:03d}"
        m = {"role": "assistant", "content": None,
             "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "shell",
                             "arguments": json.dumps({"command": ["bash", "-lc", f"sed -n '{i*70+1},{(i+1)*70}p' src/engine{seed}.js"]})}}]}
        if history_mode == 'full':
            m["reasoning_content"] = REASON_BANK[(i + seed) % len(REASON_BANK)]
        elif history_mode == 'space':
            m["reasoning_content"] = " "
        msgs.append(m)
        msgs.append({"role": "tool", "tool_call_id": call_id, "content": gen_code(seed, i)})
    msgs.append({"role": "user", "content": "You have now read the whole file; do NOT call shell again. Write the complete refactored file to src/engine_new.js in a single apply_patch call (about 300 lines, every exported function kept)."})
    return msgs

def is_loop(text):
    """最近 3000 字符压缩比很低 → 重复。"""
    if len(text) < 3000: return False
    tail = text[-3000:].encode()
    return len(zlib.compress(tail)) / len(tail) < 0.12

def run_one(key, seed, history_mode, effort):
    body = {"model": MODEL, "messages": build_messages(seed, history_mode), "tools": TOOLS, "stream": True,
            "max_tokens": MAX_TOKENS, "stream_options": {"include_usage": True}, "reasoning_effort": effort,
            "user": f"loopexp-{seed}"}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    t0 = time.time(); reasoning = []; content = []; toolargs = []; finish = None; usage = None; verdict = None; err = None
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            for raw in resp:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'): continue
                data = line[5:].strip()
                if data == '[DONE]': break
                try: ev = json.loads(data)
                except Exception: continue
                if ev.get('usage'): usage = ev['usage']
                for ch in ev.get('choices') or []:
                    d = ch.get('delta') or {}
                    if d.get('reasoning_content'): reasoning.append(d['reasoning_content'])
                    elif d.get('reasoning'): reasoning.append(d['reasoning'])
                    if d.get('content'): content.append(d['content'])
                    for tc in d.get('tool_calls') or []:
                        a = (tc.get('function') or {}).get('arguments')
                        if a: toolargs.append(a)
                    if ch.get('finish_reason'): finish = ch['finish_reason']
                rt, ct, ta = ''.join(reasoning), ''.join(content), ''.join(toolargs)
                if is_loop(rt) or is_loop(ct) or is_loop(ta):
                    verdict = 'loop'; break
                if len(rt) + len(ct) + len(ta) > ABORT_CHARS:
                    verdict = 'capped'; break
    except Exception as e:
        err = repr(e)[:200]; verdict = 'error'
    rt, ct, ta = ''.join(reasoning), ''.join(content), ''.join(toolargs)
    if verdict is None:
        verdict = 'capped' if finish == 'length' else 'ok'
    return {"seed": seed, "history": history_mode, "effort": effort, "verdict": verdict, "finish": finish, "sec": round(time.time() - t0, 1),
            "reasoning_chars": len(rt), "content_chars": len(ct), "toolargs_chars": len(ta), "usage": usage, "err": err,
            "reasoning_tail": rt[-200:] if verdict in ('loop', 'capped') else '', "content_tail": ct[-200:] if verdict in ('loop', 'capped') else ''}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', type=int, default=30)
    ap.add_argument('--out', default='results.jsonl')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--smoke', action='store_true')
    a = ap.parse_args()
    if a.dry_run:
        for hm in ('full', 'missing', 'space'):
            m = build_messages(0, hm)
            s = json.dumps(m)
            print(hm, 'messages', len(m), 'chars', len(s), '~tokens', len(s) // 3, 'assistant keys sample', sorted(m[2].keys()))
        print('is_loop test:', is_loop('结束。收尾。完成。' * 400), is_loop(gen_code(1, 1, 200)))
        return
    key = os.environ.get('CPS_KEY')
    if not key: sys.exit('set CPS_KEY')
    if a.smoke:
        print(json.dumps(run_one(key, 0, 'full', 'medium'), ensure_ascii=False)[:1500]); return
    cells = [(h, e) for h in ('full', 'missing', 'space') for e in ('medium', 'high')]
    jobs = [(i % 6, h, e) for (h, e) in cells for i in range(a.runs)]
    random.Random(7).shuffle(jobs)
    lock = threading.Lock(); done = [0]
    def work(j):
        r = run_one(key, *j)
        with lock:
            open(a.out, 'a').write(json.dumps(r, ensure_ascii=False) + '\n'); done[0] += 1
            if done[0] % 10 == 0: print('done', done[0], '/', len(jobs), flush=True)
    with ThreadPoolExecutor(a.workers) as ex: list(ex.map(work, jobs))
    rows = [json.loads(l) for l in open(a.out)]
    tab = collections.defaultdict(collections.Counter)
    for r in rows: tab[(r['history'], r['effort'])][r['verdict']] += 1
    for k in sorted(tab): print(k, dict(tab[k]))

if __name__ == '__main__':
    main()

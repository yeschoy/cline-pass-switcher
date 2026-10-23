#!/usr/bin/env python3
"""v2：真实代码历史 + 真实任务（写架构文档），仅比较 full / missing，high 档，max_tokens=32000。"""
import glob, json, os, random, sys, threading, collections, argparse
from concurrent.futures import ThreadPoolExecutor
import loop_experiment as L

L.MAX_TOKENS = 32000
L.ABORT_CHARS = 110000
REPO = '/home/ubuntu/project/cline-pass-switcher'
FILES = sorted(glob.glob(REPO + '/lib/*.js'))
CORPUS = []
for f in FILES:
    rel = os.path.relpath(f, REPO)
    for ln in open(f, encoding='utf-8').read().split('\n'):
        CORPUS.append((rel, ln))

def build(seed, history_mode, rounds=22, per=100):
    start = (seed * 397) % max(1, len(CORPUS) - rounds * per)
    msgs = [{"role": "system", "content": L.SYSTEM},
            {"role": "user", "content": "Read the library modules under lib/ in order, then write a complete architecture document docs/ARCHITECTURE.md (about 200 lines) describing what each module does and how they fit together."}]
    for i in range(rounds):
        chunk = CORPUS[start + i * per: start + (i + 1) * per]
        cid = f"call_{seed}_{i:03d}"
        m = {"role": "assistant", "content": None, "tool_calls": [{"id": cid, "type": "function", "function": {"name": "shell",
             "arguments": json.dumps({"command": ["bash", "-lc", f"sed -n '{i*per+1},{(i+1)*per}p' {chunk[0][0]}"]})}}]}
        if history_mode == 'full':
            m["reasoning_content"] = L.REASON_BANK[(i + seed) % len(L.REASON_BANK)]
        msgs.append(m)
        msgs.append({"role": "tool", "tool_call_id": cid, "content": "\n".join(x[1] for x in chunk)})
    msgs.append({"role": "user", "content": "You have now read enough; do NOT call shell again. Write docs/ARCHITECTURE.md in a single apply_patch call."})
    return msgs

L.build_messages = lambda seed, hm, rounds=24: build(seed, hm)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--runs', type=int, default=30); ap.add_argument('--out', default='results2.jsonl')
    ap.add_argument('--workers', type=int, default=6); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if a.dry_run:
        for hm in ('full', 'missing'):
            s = json.dumps(build(0, hm)); print(hm, 'chars', len(s), '~tokens', len(s) // 3.2)
        sys.exit()
    key = os.environ['CPS_KEY']
    jobs = [(i % 6, h, 'high') for h in ('full', 'missing') for i in range(a.runs)]
    random.Random(11).shuffle(jobs)
    lock = threading.Lock(); n = [0]
    def work(j):
        r = L.run_one(key, *j)
        with lock:
            open(a.out, 'a').write(json.dumps(r, ensure_ascii=False) + '\n'); n[0] += 1
            print('done', n[0], '/', len(jobs), r['history'], r['verdict'], flush=True)
    with ThreadPoolExecutor(a.workers) as ex: list(ex.map(work, jobs))

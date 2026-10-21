"""运行：python -m unittest discover -s tests -v"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from avalon.brains import HeuristicBrain, HumanBrain  # noqa: E402
from avalon.coach import compute_stats, hint, review  # noqa: E402
from avalon.deepseek import DeepSeekClient, extract_json  # noqa: E402
from avalon.engine import Game, InvalidAction  # noqa: E402
from avalon.llm import LLMBrain, make_brain_factory  # noqa: E402
from avalon.prompts import render_history, system_prompt  # noqa: E402
from avalon.rules import EVIL, GOOD, PRESETS, TEAM_SIZES, knowledge_for  # noqa: E402


def check_invariants(tc: unittest.TestCase, g: Game) -> None:
    tc.assertEqual(g.status, "ended", g.error)
    tc.assertIn(g.winner, (GOOD, EVIL))
    good, evil = g.score()
    tc.assertTrue(good <= 3 and evil <= 3)
    for q in g.quests:
        tc.assertLessEqual(len(q["attempts"]), 5)
        for a in q["attempts"]:
            tc.assertEqual(len(a["team"]), q["size"])
            tc.assertEqual(len(set(a["team"])), q["size"])
        if q["success"] is not None:
            for s, c in q["cards"].items():
                if g.team_of_seat(s) == GOOD:
                    tc.assertEqual(c, "success", "好人不能出失败")
            tc.assertEqual(q["success"], q["fails"] < q["fails_needed"])
    if g.winner == GOOD:
        tc.assertEqual(good, 3)
        tc.assertTrue(any(e["type"] == "assassination" and not e["hit"] for e in g.events))


class RulesTest(unittest.TestCase):
    def test_presets(self):
        for n, roles in PRESETS.items():
            self.assertEqual(len(roles), n)
            self.assertEqual(len(TEAM_SIZES[n]), 5)
            self.assertIn("merlin", roles)
            self.assertIn("assassin", roles)

    def test_knowledge(self):
        roles = {1: "merlin", 2: "percival", 3: "servant", 4: "servant", 5: "morgana", 6: "assassin", 7: "mordred", 8: "oberon",
                 9: "servant", 10: "servant"}
        self.assertEqual(knowledge_for(1, roles), [(5, "坏人"), (6, "坏人"), (8, "坏人")])  # 看不到莫德雷德
        self.assertEqual([s for s, _ in knowledge_for(2, roles)], [1, 5])
        self.assertEqual(knowledge_for(3, roles), [])
        self.assertEqual([s for s, _ in knowledge_for(6, roles)], [5, 7])  # 看不到奥伯伦
        self.assertEqual(knowledge_for(8, roles), [])


class EngineTest(unittest.TestCase):
    def test_bot_games_all_sizes(self):
        for n in range(5, 11):
            for seed in range(40):
                g = Game(n, human=False, seed=seed, lady=n >= 7)
                g.run()
                check_invariants(self, g)

    def test_lady_of_the_lake(self):
        g = Game(8, human=False, seed=3, lady=True)
        g.run()
        check_invariants(self, g)
        holders = [r["holder"] for r in g.lady_log]
        targets = [r["target"] for r in g.lady_log]
        self.assertEqual(len(set(holders + targets[-1:])), len(holders) + (1 if targets else 0))
        for r in g.lady_log:
            self.assertEqual(r["result"], g.team_of_seat(r["target"]))

    def test_human_role_and_seat(self):
        g = Game(7, human_seat=4, human_role="merlin", seed=1)
        self.assertEqual(g.role_of(4), "merlin")
        self.assertTrue(g.players[4].is_human)
        self.assertEqual(sorted(p.role for p in g.players.values()), sorted(PRESETS[7]))

    def test_private_events_visibility(self):
        g = Game(8, human=False, seed=5, lady=True)
        g.run()
        self.assertTrue(g.lady_log)
        holder = g.lady_log[0]["holder"]
        outsider = next(s for s in g.seats if s not in [r["holder"] for r in g.lady_log])
        self.assertIn("（仅你可见）", render_history(g, holder))
        self.assertNotIn("（仅你可见）", render_history(g, outsider))
        self.assertIn("（真实结果）", render_history(g, None, god=True))
        # 对局进行中：外人看不到私密事件和内心独白；结束后全部公开
        g.human_seat = outsider
        g.status = "running"
        st = g.client_state()
        self.assertFalse([e for e in st["events"] if e["type"] == "lady_result"])
        self.assertFalse([e for e in st["events"] if "thoughts" in e or "secret" in e])
        g.status = "ended"
        st = g.client_state()
        self.assertTrue([e for e in st["events"] if e["type"] == "lady_result"])
        self.assertTrue([e for e in st["events"] if "secret" in e])


def auto_human(game: Game, stop: threading.Event, mistakes: list):
    """模拟人类玩家：先故意提交一个非法操作，再提交合法操作。"""
    while not stop.is_set():
        p = game.pending
        if not p:
            time.sleep(0.002)
            continue
        kind = p["type"]
        if kind == "propose":
            try:
                game.submit({"pending_id": p["id"], "team": [1]})
            except InvalidAction as e:
                mistakes.append(str(e))
            game.submit({"pending_id": p["id"], "team": list(range(1, p["size"] + 1)), "speech": "我带这几个"})
        elif kind == "speak":
            game.submit({"pending_id": p["id"], "speech": "我觉得可以"})
        elif kind == "vote":
            game.submit({"pending_id": p["id"], "vote": True})
        elif kind == "quest":
            if not p["can_fail"]:
                try:
                    game.submit({"pending_id": p["id"], "card": "fail"})
                except InvalidAction as e:
                    mistakes.append(str(e))
            game.submit({"pending_id": p["id"], "card": "fail" if p["can_fail"] else "success"})
        elif kind == "lady_announce":
            game.submit({"pending_id": p["id"], "claim": "good", "speech": "他是好人"})
        else:
            game.submit({"pending_id": p["id"], "target": p["candidates"][0], "speech": "就他了"})


class HumanFlowTest(unittest.TestCase):
    def play(self, n, role, seed):
        g = Game(n, human_seat=2, human_role=role, seed=seed, lady=True)
        stop = threading.Event()
        mistakes: list = []
        t = threading.Thread(target=auto_human, args=(g, stop, mistakes), daemon=True)
        t.start()
        g.run()
        stop.set()
        check_invariants(self, g)
        return g, mistakes

    def test_human_games(self):
        for role in ("merlin", "servant", "assassin", "morgana", "percival", "oberon"):
            for seed in range(4):
                g, mistakes = self.play(7, role, seed)
                led = any(a["leader"] == 2 for q in g.quests for a in q["attempts"])
                self.assertEqual(led, any("需要" in m for m in mistakes))
                if role in ("merlin", "servant", "percival"):
                    self.assertTrue(all("好人只能出成功" in m or "需要" in m for m in mistakes))

    def test_cancel_unblocks(self):
        g = Game(5, human_seat=1, seed=1)
        g.start()
        for _ in range(500):
            if g.pending:
                break
            time.sleep(0.01)
        self.assertIsNotNone(g.pending)
        g.cancel()
        g.thread.join(timeout=5)
        self.assertFalse(g.thread.is_alive())
        self.assertEqual(g.status, "cancelled")

    def test_stale_pending_rejected(self):
        g = Game(5, human_seat=1, seed=1)
        g.start()
        for _ in range(500):
            if g.pending:
                break
            time.sleep(0.01)
        with self.assertRaises(InvalidAction):
            g.submit({"pending_id": 999, "speech": "x"})
        g.cancel()


# ---------------------------------------------------------------------- 假 DeepSeek
def fake_reply(messages: list[dict]) -> str:
    """根据提示词内容给出合法答复，模拟 DeepSeek 的 JSON 输出。"""
    prompt = messages[-1]["content"]
    if "的表现做复盘" in prompt or "身份推测" in prompt:
        return "### 胜负关键\n- **测试**复盘内容"
    task = prompt.split("## 现在轮到你")[-1]
    thought = "我在认真思考"
    if '"team"' in task:
        k = int(re.search(r"请提名(\d+)名玩家", task).group(1))
        return json.dumps({"thought": thought, "team": [f"{i}号" for i in range(1, k + 1)], "speech": "我带前几位"}, ensure_ascii=False)
    if '"vote"' in task:
        return "```json\n" + json.dumps({"thought": thought, "vote": "赞成"}, ensure_ascii=False) + "\n```"
    if '"card"' in task:
        return json.dumps({"thought": thought, "card": "失败"}, ensure_ascii=False)
    if '"claim"' in task:
        return json.dumps({"thought": thought, "claim": "好人", "speech": "他是好人"}, ensure_ascii=False)
    if '"target"' in task:
        cand = re.search(r"(?:可选|候选（所有好人）|候选)：([\d号、]+)", task)
        first = int(re.search(r"\d+", cand.group(1)).group())
        return json.dumps({"thought": thought, "target": first, "speech": "我选他"}, ensure_ascii=False)
    return json.dumps({"thought": thought, "speech": "这车我觉得没问题"}, ensure_ascii=False)


class FakeDeepSeek:
    def __init__(self, mode="ok"):
        self.mode = mode
        self.calls = 0
        self.tasks: list[str] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, data):
                raw = json.dumps(data, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer good-key":
                    return self._send(401, {"error": {"message": "auth"}})
                self._send(200, {"data": [{"id": "deepseek-chat"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls += 1
                outer.tasks.append(body["messages"][-1]["content"].split("## 现在轮到你")[-1])
                if self.headers.get("Authorization") != "Bearer good-key":
                    return self._send(401, {"error": {"message": "auth"}})
                content = "这不是JSON" if outer.mode == "garbage" else fake_reply(body["messages"])
                self._send(200, {
                    "choices": [{"message": {"role": "assistant", "content": content}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 60},
                })

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


class LLMTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeDeepSeek()

    def tearDown(self):
        self.fake.close()

    def client(self, key="good-key"):
        return DeepSeekClient(key, base_url=self.fake.url, max_retries=0)

    def test_extract_json(self):
        self.assertEqual(extract_json('好的：{"a": 1} 完毕')["a"], 1)
        self.assertEqual(extract_json('```json\n{"a": 2}\n```')["a"], 2)
        with self.assertRaises(ValueError):
            extract_json("没有")

    def test_check_key(self):
        self.assertIn("deepseek-chat", self.client().check())

    def test_quest_calls_do_not_reveal_evil(self):
        """出任务时车上每个 AI 都要调用模型：否则耗时、思考标记、调用次数会暴露谁是坏人。"""
        client = self.client()
        g = Game(7, human=False, seed=11, brain_factory=make_brain_factory(client))
        g.run()
        check_invariants(self, g)
        quest_prompts = [t for t in self.fake.tasks if '"card"' in t]
        played = sum(len(q["team"]) for q in g.quests if q["team"])
        self.assertEqual(len(quest_prompts), played)  # 好人坏人一视同仁
        self.assertTrue(any("你是好人，只能出" in t for t in quest_prompts))
        for q in g.quests:
            for s, c in (q.get("cards") or {}).items():
                if g.team_of_seat(s) == GOOD:
                    self.assertEqual(c, "success")

    def test_full_llm_game(self):
        client = self.client()
        g = Game(7, human=False, seed=11, lady=True, brain_factory=make_brain_factory(client))
        g.client = client
        g.run()
        check_invariants(self, g)
        self.assertEqual(g.ai_failures, 0)
        self.assertGreater(client.usage["calls"], 20)
        self.assertEqual(client.usage["cache_hit_tokens"], client.usage["calls"] * 60)
        speeches = [e for e in g.events if e["type"] == "speech" and not e.get("leader") and not e.get("assassin")]
        self.assertTrue(speeches and all(e.get("thoughts") for e in speeches))
        # 坏人都出失败，好人从不出失败
        for q in g.quests:
            for s, c in (q.get("cards") or {}).items():
                self.assertEqual(c, "fail" if g.team_of_seat(s) == EVIL else "success")

    def test_bad_key_falls_back_once(self):
        client = self.client("bad-key")
        g = Game(5, human=False, seed=2, brain_factory=make_brain_factory(client))
        g.run()
        check_invariants(self, g)
        self.assertTrue(client.disabled_reason)
        warns = [e for e in g.events if e["type"] == "system" and e.get("level") == "warn"]
        self.assertEqual(len(warns), 1)
        self.assertLessEqual(self.fake.calls, 2)

    def test_garbage_output_falls_back(self):
        self.fake.mode = "garbage"
        client = self.client()
        g = Game(5, human=False, seed=4, brain_factory=make_brain_factory(client))
        g.run()
        check_invariants(self, g)
        self.assertGreater(g.ai_failures, 0)

    def test_prompts_keep_secrets(self):
        g = Game(7, human=False, seed=8)
        merlin = g.seat_of_role("merlin")
        servant = g.seat_of_role("servant")
        evil = g.evil_seats()
        sp = system_prompt(g, servant)
        self.assertIn("你没有任何额外信息", sp)
        sm = system_prompt(g, merlin)
        for s in evil:
            self.assertIn(f"{s}号", sm.split("你看到的坏人是：")[1].split("。")[0])

    def test_coach(self):
        client = self.client()
        g = Game(5, human_seat=1, seed=3, brain_factory=make_brain_factory(client))
        g.client = client
        stop = threading.Event()
        t = threading.Thread(target=auto_human, args=(g, stop, []), daemon=True)
        t.start()
        g.run()
        stop.set()
        self.assertIn("测试", review(g, client))
        stats = compute_stats(g)
        self.assertEqual(set(stats), set(g.seats))
        # 离线教练
        g2 = Game(5, human_seat=1, seed=3)
        self.assertIn("离线教练", hint(g2, None))


class ServerTest(unittest.TestCase):
    def test_api_flow(self):
        from avalon.server import App, make_handler

        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        app = App(offline_pace=0, records_dir=Path(tmp.name))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def call(path, body=None):
            req = urllib.request.Request(
                base + path,
                data=None if body is None else json.dumps(body).encode(),
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        try:
            self.assertEqual(call("/api/config")[1]["presets"]["7"]["team_sizes"], [2, 3, 3, 4, 4])
            code, err = call("/api/games", {"num_players": 7, "mode": "llm"})
            self.assertEqual(code, 400)  # 没有 key
            code, data = call("/api/games", {"num_players": 6, "mode": "offline", "seat": "3", "role": "percival", "name": "测试员"})
            self.assertEqual(code, 200)
            gid = data["id"]
            deadline = time.time() + 30
            since = 0
            while time.time() < deadline:
                code, st = call(f"/api/games/{gid}/state?since={since}")
                since = st["last_event_id"]
                if st["status"] == "ended":
                    break
                p = st["pending"]
                if p:
                    body = {"pending_id": p["id"]}
                    if p["type"] == "propose":
                        body["team"] = list(range(1, p["size"] + 1))
                    elif p["type"] == "vote":
                        body["vote"] = False
                    elif p["type"] == "quest":
                        body["card"] = "success"
                    elif p["type"] == "lady_announce":
                        body["claim"] = "none"
                    elif "candidates" in p:
                        body["target"] = p["candidates"][0]
                    code, res = call(f"/api/games/{gid}/action", body)
                    self.assertEqual(code, 200, res)
                time.sleep(0.01)
            self.assertEqual(st["status"], "ended")
            self.assertEqual(st["you"]["role"], "percival")
            self.assertEqual(st["players"][2]["name"], "测试员")
            code, full = call(f"/api/games/{gid}/state?since=0")
            self.assertIn("stats", full)
            self.assertTrue(all("role" in p for p in full["players"]))
            code, rv = call(f"/api/games/{gid}/review", {})
            self.assertIn("身份揭晓", rv["text"])
            self.assertEqual(len(list(Path(tmp.name).glob("*.json"))), 1)
            # 观战模式：全程上帝视角
            code, data = call("/api/games", {"num_players": 5, "mode": "offline", "seat": "watch"})
            code, st = call(f"/api/games/{data['id']}/state?since=0")
            self.assertTrue(st["spectator"])
            self.assertIsNone(st["you"])
            self.assertTrue(all("role" in p for p in st["players"]))
            self.assertEqual(call(f"/api/games/{data['id']}/hint", {})[0], 400)
            call(f"/api/games/{data['id']}/abort", {})
            self.assertEqual(call("/api/games/nope/state")[0], 404)
            self.assertEqual(call("/static/../avalon/server.py")[0], 404)
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    unittest.main()

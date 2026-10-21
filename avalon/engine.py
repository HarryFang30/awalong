"""对局引擎：在后台线程中按规则推进游戏，向每个座位的“大脑”（人类 / 离线AI / DeepSeek）索取决策。"""
from __future__ import annotations

import queue
import random
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .rules import (
    EVIL,
    GOOD,
    LADY_AFTER_QUESTS,
    MAX_REJECTS,
    PRESETS,
    ROLES,
    TEAM_NAMES,
    TEAM_SIZES,
    fails_required,
    knowledge_for,
    team_of,
)
from .personas import PERSONAS


class GameCancelled(Exception):
    pass


class InvalidAction(ValueError):
    pass


_CANCEL = object()


@dataclass
class Player:
    seat: int
    name: str
    persona: str
    role: str
    is_human: bool = False
    brain: Any = None

    @property
    def team(self) -> str:
        return team_of(self.role)

    @property
    def role_name(self) -> str:
        return ROLES[self.role].name


def seats_text(seats) -> str:
    return "、".join(f"{s}号" for s in sorted(seats)) if seats else "无"


class Game:
    def __init__(
        self,
        num_players: int,
        *,
        human: bool = True,
        human_seat: Optional[int] = None,
        human_role: Optional[str] = None,
        human_name: str = "玩家",
        lady: bool = False,
        seed: Optional[int] = None,
        pace: float = 0.0,
        speech_len: int = 80,
        brain_factory: Optional[Callable[["Game", Player], Any]] = None,
        on_finish: Optional[Callable[["Game"], None]] = None,
    ):
        if num_players not in PRESETS:
            raise ValueError("人数必须在 5~10 之间")
        self.id = uuid.uuid4().hex[:12]
        self.rng = random.Random(seed)
        self.n = num_players
        self.pace = pace
        self.speech_len = speech_len
        self.lady_enabled = lady
        self.on_finish = on_finish
        self.created_at = time.time()

        roles = list(PRESETS[num_players])
        if human:
            if human_seat is None:
                human_seat = self.rng.randint(1, num_players)
            if not 1 <= human_seat <= num_players:
                raise ValueError("座位号超出范围")
            if human_role:
                if human_role not in roles:
                    raise ValueError(f"{num_players}人局没有这个角色")
                roles.remove(human_role)
        self.rng.shuffle(roles)
        if human and human_role:
            roles.insert(human_seat - 1, human_role)
        self.human_seat: Optional[int] = human_seat if human else None

        personas = self.rng.sample(PERSONAS, num_players)
        self.players: dict[int, Player] = {}
        for seat in range(1, num_players + 1):
            is_human = seat == self.human_seat
            name, persona = ((human_name.strip() or "玩家")[:12], "人类玩家") if is_human else personas[seat - 1]
            self.players[seat] = Player(seat, name, persona, roles[seat - 1], is_human)

        self.quests: list[dict] = [
            {
                "index": i,
                "size": TEAM_SIZES[num_players][i],
                "fails_needed": fails_required(num_players, i),
                "attempts": [],
                "team": None,
                "fails": None,
                "success": None,
            }
            for i in range(5)
        ]
        self.quest_index = 0
        self.attempt = 0
        self.leader: Optional[int] = None
        self.proposal: Optional[list[int]] = None
        self.phase = "setup"
        self.lady_holder: Optional[int] = None
        self.lady_used: list[int] = []
        self.lady_log: list[dict] = []
        self.evil_revealed = False
        self.winner: Optional[str] = None
        self.end_reason = ""
        self.status = "created"
        self.error = ""

        self.events: list[dict] = []
        self.pending: Optional[dict] = None
        self.thinking: set[int] = set()
        self.lock = threading.RLock()
        self._human_q: "queue.Queue[Any]" = queue.Queue()
        self._pending_seq = 0
        self.cancelled = False
        self.thread: Optional[threading.Thread] = None
        self.client = None  # DeepSeek 客户端（可选），用于统计用量
        self.ai_failures = 0
        self._failure_notes: set[str] = set()
        self.review_text: Optional[str] = None

        if brain_factory is None:
            from .brains import default_brain_factory

            brain_factory = default_brain_factory
        for p in self.players.values():
            p.brain = brain_factory(self, p)

    # ------------------------------------------------------------------ 工具
    @property
    def seats(self) -> list[int]:
        return list(range(1, self.n + 1))

    def role_of(self, seat: int) -> str:
        return self.players[seat].role

    def team_of_seat(self, seat: int) -> str:
        return self.players[seat].team

    def evil_seats(self) -> list[int]:
        return [s for s in self.seats if self.team_of_seat(s) == EVIL]

    def seat_of_role(self, role: str) -> Optional[int]:
        for s, p in self.players.items():
            if p.role == role:
                return s
        return None

    def _next(self, seat: int) -> int:
        return seat % self.n + 1

    def _prev(self, seat: int) -> int:
        return (seat - 2) % self.n + 1

    def order_after(self, seat: int) -> list[int]:
        return [(seat + i - 1) % self.n + 1 for i in range(1, self.n)]

    def score(self) -> tuple[int, int]:
        good = sum(1 for q in self.quests if q["success"] is True)
        evil = sum(1 for q in self.quests if q["success"] is False)
        return good, evil

    def knowledge(self, seat: int) -> list[tuple[int, str]]:
        return knowledge_for(seat, {s: p.role for s, p in self.players.items()})

    def known_alignments(self, seat: int) -> dict[int, str]:
        """某座位当前掌握的阵营信息：{座位: 'good'|'evil'|'merlin?'}（只含确定信息和派西维尔的二选一）。"""
        info: dict[int, str] = {seat: self.team_of_seat(seat)}
        role = self.role_of(seat)
        for s, label in self.knowledge(seat):
            info[s] = "merlin?" if label == "梅林或莫甘娜" else EVIL
        for rec in self.lady_log:
            if rec["holder"] == seat:
                info[rec["target"]] = rec["result"]
        if self.evil_revealed:
            for s in self.seats:
                info[s] = self.team_of_seat(s)
        if role == "oberon":
            info[seat] = EVIL
        return info

    # ------------------------------------------------------------------ 事件
    def emit(self, type_: str, *, vis=None, thoughts=None, secret=None, **data) -> dict:
        with self.lock:
            ev = {
                "id": len(self.events) + 1,
                "type": type_,
                "quest": self.quest_index,
                "attempt": self.attempt,
                **data,
            }
            if vis is not None:
                ev["vis"] = sorted(vis)
            if thoughts:
                cleaned = {str(k): v for k, v in thoughts.items() if v}
                if cleaned:
                    ev["thoughts"] = cleaned
            if secret:
                ev["secret"] = secret
            self.events.append(ev)
            return ev

    @staticmethod
    def visible(ev: dict, viewer: Optional[int]) -> bool:
        if viewer is None or "vis" not in ev:
            return True
        return viewer in ev["vis"]

    # ------------------------------------------------------------------ 人类输入
    def request_human(self, spec: dict) -> dict:
        with self.lock:
            if self.cancelled:
                raise GameCancelled()
            self._pending_seq += 1
            self.pending = dict(spec, id=self._pending_seq)
        resp = self._human_q.get()
        if resp is _CANCEL:
            raise GameCancelled()
        return resp

    def submit(self, data: dict) -> None:
        with self.lock:
            p = self.pending
            if not p:
                raise InvalidAction("现在还没轮到你行动")
            if data.get("pending_id") is not None and data.get("pending_id") != p["id"]:
                raise InvalidAction("这个操作已经过期了，请刷新页面")
            resp = self._validate(p, data)
            self.pending = None
            self._human_q.put(resp)

    def _validate(self, p: dict, data: dict) -> dict:
        kind = p["type"]
        speech = str(data.get("speech") or "").strip()[:500]
        if kind == "propose":
            team = data.get("team")
            if not isinstance(team, list):
                raise InvalidAction("请选择队员")
            try:
                team = sorted({int(s) for s in team})
            except (TypeError, ValueError):
                raise InvalidAction("队员格式不对")
            if len(team) != p["size"] or any(s not in self.players for s in team):
                raise InvalidAction(f"需要选择 {p['size']} 名不同的玩家")
            return {"team": team, "speech": speech}
        if kind == "speak":
            return {"speech": speech}
        if kind == "vote":
            if not isinstance(data.get("vote"), bool):
                raise InvalidAction("请选择赞成或反对")
            return {"vote": data["vote"]}
        if kind == "quest":
            card = data.get("card")
            if card not in ("success", "fail"):
                raise InvalidAction("请选择任务牌")
            if card == "fail" and not p.get("can_fail"):
                raise InvalidAction("好人只能出成功")
            return {"card": card}
        if kind in ("lady_choose", "assassin_suggest", "assassinate"):
            try:
                target = int(data.get("target"))
            except (TypeError, ValueError):
                raise InvalidAction("请选择一名玩家")
            if target not in p["candidates"]:
                raise InvalidAction("不能选择这名玩家")
            return {"target": target, "speech": speech}
        if kind == "lady_announce":
            claim = data.get("claim")
            if claim not in ("good", "evil", "none"):
                raise InvalidAction("请选择要公布的结果")
            return {"claim": None if claim == "none" else claim, "speech": speech}
        raise InvalidAction("未知操作")

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            if self.status in ("created", "running"):
                self.status = "cancelled"
        self._human_q.put(_CANCEL)

    def _check_cancel(self) -> None:
        if self.cancelled:
            raise GameCancelled()

    # ------------------------------------------------------------------ 调用大脑
    @contextmanager
    def _thinking(self, seat: int):
        with self.lock:
            self.thinking.add(seat)
        try:
            yield
        finally:
            with self.lock:
                self.thinking.discard(seat)

    def ask(self, seat: int, method: str, *args):
        self._check_cancel()
        player = self.players[seat]
        if player.is_human:
            dec = getattr(player.brain, method)(*args)
        else:
            with self._thinking(seat):
                dec = getattr(player.brain, method)(*args)
        self._check_cancel()
        return dec

    def ask_many(self, seats: list[int], method: str, *args) -> dict:
        ex = ThreadPoolExecutor(max_workers=max(1, len(seats)))
        try:
            futures = {s: ex.submit(self.ask, s, method, *args) for s in seats}
            return {s: f.result() for s, f in futures.items()}
        finally:
            ex.shutdown(wait=False)

    def note_ai_failure(self, seat: int, error: str) -> None:
        """AI 调用失败、改用离线策略时记录，同类错误只提示一次。"""
        with self.lock:
            self.ai_failures += 1
            key = error[:40]
            if key in self._failure_notes:
                return
            self._failure_notes.add(key)
        self.emit("system", text=f"{seat}号的 AI 调用失败（{error}），本次改用离线策略。", level="warn")

    def _pace(self, seat: int) -> None:
        if self.pace > 0 and not self.players[seat].is_human:
            time.sleep(self.pace)

    # ------------------------------------------------------------------ 主流程
    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name=f"avalon-{self.id}", daemon=True)
        self.thread.start()

    def run(self) -> None:
        with self.lock:
            if self.status == "created":
                self.status = "running"
        try:
            self._play()
        except GameCancelled:
            with self.lock:
                self.status = "cancelled"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            with self.lock:
                self.status = "error"
                self.error = f"{type(e).__name__}: {e}"
            self.emit("system", text=f"游戏出现错误：{self.error}")
        finally:
            with self.lock:
                self.pending = None
                self.thinking.clear()
            if self.on_finish:
                try:
                    self.on_finish(self)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()

    def _play(self) -> None:
        self.leader = self.rng.randint(1, self.n)
        if self.lady_enabled:
            self.lady_holder = self._prev(self.leader)
            self.lady_used = [self.lady_holder]
        self.emit("start", leader=self.leader, lady=self.lady_holder)

        for qi in range(5):
            self.quest_index = qi
            self.attempt = 0
            q = self.quests[qi]
            self.emit("quest_start", size=q["size"], fails_needed=q["fails_needed"])
            team: list[int] = []
            for attempt in range(1, MAX_REJECTS + 1):
                self.attempt = attempt
                team, approved = self._attempt(q, attempt)
                self.leader = self._next(self.leader)
                if approved:
                    break
            else:
                self._end(EVIL, "同一轮任务连续5次提名都被否决，坏人获胜。")
                return

            self._quest(q, team)
            good, evil = self.score()
            if evil >= 3:
                self._end(EVIL, "坏人让3次任务失败，坏人获胜。")
                return
            if good >= 3:
                self._assassination()
                return
            if self.lady_enabled and qi in LADY_AFTER_QUESTS:
                self._lady()

    def _sanitize_team(self, team, size: int, leader: int) -> list[int]:
        clean: list[int] = []
        for s in team or []:
            try:
                s = int(s)
            except (TypeError, ValueError):
                continue
            if s in self.players and s not in clean:
                clean.append(s)
        if len(clean) != size:
            clean = clean[:size]
            if leader not in clean and len(clean) < size:
                clean.append(leader)
            others = [s for s in self.seats if s not in clean]
            self.rng.shuffle(others)
            while len(clean) < size:
                clean.append(others.pop())
        return sorted(clean)

    def _attempt(self, q: dict, attempt: int) -> tuple[list[int], bool]:
        leader = self.leader
        with self.lock:
            self.phase = "propose"
            self.proposal = None
        dec = self.ask(leader, "propose", q["size"])
        team = self._sanitize_team(dec.value, q["size"], leader)
        rec = {"n": attempt, "leader": leader, "team": team, "votes": None, "approved": None}
        with self.lock:
            q["attempts"].append(rec)
            self.proposal = team
            self.phase = "discuss"
        self.emit("proposal", leader=leader, team=team, size=q["size"], thoughts={leader: dec.thought})
        if dec.speech:
            self.emit("speech", seat=leader, text=dec.speech, leader=True)
        self._pace(leader)

        for seat in self.order_after(leader):
            d = self.ask(seat, "speak", team)
            self.emit("speech", seat=seat, text=d.speech or "", thoughts={seat: d.thought})
            self._pace(seat)

        with self.lock:
            self.phase = "vote"
        decs = self.ask_many(self.seats, "vote", team)
        votes = {s: bool(decs[s].value) for s in self.seats}
        approvals = sum(votes.values())
        approved = approvals * 2 > self.n
        with self.lock:
            rec["votes"] = votes
            rec["approved"] = approved
        self.emit(
            "vote",
            leader=leader,
            team=team,
            votes={str(s): v for s, v in votes.items()},
            approvals=approvals,
            approved=approved,
            thoughts={s: decs[s].thought for s in self.seats},
        )
        return team, approved

    def _quest(self, q: dict, team: list[int]) -> None:
        with self.lock:
            self.phase = "quest"
            self.proposal = team
        decs = self.ask_many(team, "quest", team)
        cards: dict[int, str] = {}
        for s in team:
            card = decs[s].value if decs[s].value in ("success", "fail") else "success"
            if self.team_of_seat(s) == GOOD:
                card = "success"
            cards[s] = card
        fails = sum(1 for c in cards.values() if c == "fail")
        success = fails < q["fails_needed"]
        with self.lock:
            q.update(team=team, fails=fails, success=success, cards=cards)
        good, evil = self.score()
        self.emit(
            "quest_result",
            team=team,
            fails=fails,
            success=success,
            fails_needed=q["fails_needed"],
            score=[good, evil],
            secret={"cards": {str(s): c for s, c in cards.items()}},
            thoughts={s: decs[s].thought for s in team},
        )

    def _lady(self) -> None:
        holder = self.lady_holder
        candidates = [s for s in self.seats if s not in self.lady_used]
        if holder is None or not candidates:
            return
        with self.lock:
            self.phase = "lady"
            self.proposal = None
        d = self.ask(holder, "lady_choose", candidates)
        target = d.value if d.value in candidates else self.rng.choice(candidates)
        result = self.team_of_seat(target)
        rec = {"holder": holder, "target": target, "result": result, "claim": None, "quest": self.quest_index}
        with self.lock:
            self.lady_log.append(rec)
        self.emit("lady_check", holder=holder, target=target, thoughts={holder: d.thought})
        self.emit("lady_result", vis=[holder], holder=holder, target=target, result=result)
        d2 = self.ask(holder, "lady_announce", target, result)
        claim = d2.value if d2.value in (GOOD, EVIL) else None
        rec["claim"] = claim
        self.emit("lady_claim", holder=holder, target=target, claim=claim, text=d2.speech or "", thoughts={holder: d2.thought})
        self._pace(holder)
        with self.lock:
            self.lady_holder = target
            self.lady_used.append(target)

    def _assassination(self) -> None:
        with self.lock:
            self.phase = "assassinate"
            self.proposal = None
            self.evil_revealed = True
        evil = self.evil_seats()
        assassin = self.seat_of_role("assassin") or evil[0]
        candidates = [s for s in self.seats if s not in evil]
        self.emit("evil_reveal", evil=evil, assassin=assassin)
        for s in evil:
            if s == assassin:
                continue
            d = self.ask(s, "assassin_suggest", candidates)
            target = d.value if d.value in candidates else None
            self.emit("speech", seat=s, text=d.speech or "", suggest=target, thoughts={s: d.thought})
            self._pace(s)
        d = self.ask(assassin, "assassinate", candidates)
        target = d.value if d.value in candidates else self.rng.choice(candidates)
        if d.speech:
            self.emit("speech", seat=assassin, text=d.speech, assassin=True)
        hit = self.role_of(target) == "merlin"
        self.emit("assassination", assassin=assassin, target=target, hit=hit, thoughts={assassin: d.thought})
        if hit:
            self._end(EVIL, f"好人完成了3次任务，但刺客刺中了梅林（{target}号），坏人翻盘！")
        else:
            merlin = self.seat_of_role("merlin")
            self._end(GOOD, f"好人完成了3次任务，刺客刺杀了{target}号，没有刺中梅林（{merlin}号），好人获胜！")

    def _end(self, winner: str, reason: str) -> None:
        with self.lock:
            self.winner = winner
            self.end_reason = reason
            self.phase = "ended"
            self.status = "ended"
            self.pending = None
        self.emit(
            "game_end",
            winner=winner,
            reason=reason,
            roles={str(s): p.role for s, p in self.players.items()},
        )

    # ------------------------------------------------------------------ 序列化
    def client_state(self, since: int = 0) -> dict:
        """给前端（人类玩家视角）的状态。对局结束后公开全部信息。"""
        with self.lock:
            viewer = self.human_seat
            # 观战模式（没有人类玩家）全程上帝视角
            reveal = self.status == "ended" or viewer is None
            events = []
            for ev in self.events:
                if ev["id"] <= since:
                    continue
                if not reveal and not self.visible(ev, viewer):
                    continue
                out = {k: v for k, v in ev.items() if k not in ("thoughts", "secret", "vis")}
                if "vis" in ev:
                    out["private"] = True
                if reveal:
                    if "thoughts" in ev:
                        out["thoughts"] = ev["thoughts"]
                    if "secret" in ev:
                        out["secret"] = ev["secret"]
                events.append(out)

            known = {}
            if viewer is not None:
                for s, label in self.knowledge(viewer):
                    known[s] = label
                for rec in self.lady_log:
                    if rec["holder"] == viewer:
                        known[rec["target"]] = "查验：" + TEAM_NAMES[rec["result"]]
            players = []
            for s, p in self.players.items():
                item = {"seat": s, "name": p.name, "persona": p.persona, "is_human": p.is_human}
                if s in known:
                    item["known"] = known[s]
                if self.evil_revealed and p.team == EVIL:
                    item["known"] = "坏人（已亮明）"
                if reveal or s == viewer:
                    item["role"] = p.role
                    item["role_name"] = p.role_name
                    item["team"] = p.team
                players.append(item)

            you = None
            if viewer is not None:
                me = self.players[viewer]
                you = {
                    "seat": viewer,
                    "role": me.role,
                    "role_name": me.role_name,
                    "team": me.team,
                    "ability": ROLES[me.role].ability,
                    "knowledge": [{"seat": s, "label": l} for s, l in self.knowledge(viewer)],
                }

            quests = [
                {k: q[k] for k in ("index", "size", "fails_needed", "team", "fails", "success")}
                | {"attempts": len(q["attempts"])}
                for q in self.quests
            ]
            usage = self.client.usage_snapshot() if self.client else None
            return {
                "id": self.id,
                "status": self.status,
                "phase": self.phase,
                "error": self.error,
                "n": self.n,
                "players": players,
                "you": you,
                "quests": quests,
                "quest_index": self.quest_index,
                "attempt": self.attempt,
                "leader": self.leader,
                "proposal": self.proposal,
                "lady_enabled": self.lady_enabled,
                "lady_holder": self.lady_holder,
                "lady_used": self.lady_used,
                "score": list(self.score()),
                "winner": self.winner,
                "end_reason": self.end_reason,
                "pending": dict(self.pending) if self.pending else None,
                "thinking": sorted(self.thinking),
                "events": events,
                "last_event_id": self.events[-1]["id"] if self.events else 0,
                "usage": usage,
                "ai_failures": self.ai_failures,
                "llm": self.client is not None,
                "spectator": viewer is None,
            }

    def record(self) -> dict:
        """完整对局记录（上帝视角），用于存档和复盘。"""
        with self.lock:
            return {
                "id": self.id,
                "created_at": self.created_at,
                "n": self.n,
                "human_seat": self.human_seat,
                "lady": self.lady_enabled,
                "players": [
                    {"seat": p.seat, "name": p.name, "persona": p.persona, "role": p.role, "is_human": p.is_human}
                    for p in self.players.values()
                ],
                "quests": self.quests,
                "lady_log": self.lady_log,
                "winner": self.winner,
                "end_reason": self.end_reason,
                "events": self.events,
                "usage": self.client.usage_snapshot() if self.client else None,
                "review": self.review_text,
            }

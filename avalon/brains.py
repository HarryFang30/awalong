"""玩家“大脑”：人类玩家（等待网页输入）和离线规则AI（无 API Key 时使用，也是 DeepSeek 出错时的兜底）。"""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .rules import EVIL, GOOD

if TYPE_CHECKING:
    from .engine import Game, Player


@dataclass
class Decision:
    value: Any = None
    speech: str = ""
    thought: str = ""
    fallback: bool = False


class HumanBrain:
    """把决策请求挂到 game.pending 上，阻塞等待网页提交。"""

    def __init__(self, game: "Game", seat: int):
        self.game = game
        self.seat = seat

    def _ask(self, spec: dict) -> dict:
        return self.game.request_human(spec)

    def propose(self, size: int) -> Decision:
        r = self._ask({"type": "propose", "size": size})
        return Decision(r["team"], speech=r["speech"])

    def speak(self, team: list[int]) -> Decision:
        r = self._ask({"type": "speak", "team": team})
        return Decision(None, speech=r["speech"])

    def vote(self, team: list[int]) -> Decision:
        r = self._ask({"type": "vote", "team": team})
        return Decision(r["vote"])

    def quest(self, team: list[int]) -> Decision:
        q = self.game.quests[self.game.quest_index]
        can_fail = self.game.team_of_seat(self.seat) == EVIL
        r = self._ask({"type": "quest", "team": team, "can_fail": can_fail, "fails_needed": q["fails_needed"]})
        return Decision(r["card"])

    def lady_choose(self, candidates: list[int]) -> Decision:
        r = self._ask({"type": "lady_choose", "candidates": candidates})
        return Decision(r["target"])

    def lady_announce(self, target: int, result: str) -> Decision:
        r = self._ask({"type": "lady_announce", "target": target, "result": result})
        return Decision(r["claim"], speech=r["speech"])

    def assassin_suggest(self, candidates: list[int]) -> Decision:
        r = self._ask({"type": "assassin_suggest", "candidates": candidates})
        return Decision(r["target"], speech=r["speech"])

    def assassinate(self, candidates: list[int]) -> Decision:
        r = self._ask({"type": "assassinate", "candidates": candidates})
        return Decision(r["target"], speech=r["speech"])


def _fmt(seats) -> str:
    return "、".join(f"{s}号" for s in sorted(seats))


class HeuristicBrain:
    """简单但合理的规则AI：根据任务结果和已知信息算怀疑度。"""

    def __init__(self, game: "Game", seat: int):
        self.game = game
        self.seat = seat
        self.rng = random.Random(game.rng.random())

    # ------------------------------------------------------------- 信息
    @property
    def me(self) -> "Player":
        return self.game.players[self.seat]

    @property
    def evil(self) -> bool:
        return self.me.team == EVIL

    def mates(self) -> set[int]:
        """自己已知的坏人（坏人视角，含自己）。"""
        known = self.game.known_alignments(self.seat)
        return {s for s, t in known.items() if t == EVIL}

    def public_suspicion(self) -> dict[int, float]:
        g = self.game
        sus = {s: 0.0 for s in g.seats}
        for q in g.quests:
            if q["success"] is None:
                continue
            team = q["team"]
            final = q["attempts"][-1]
            votes = final["votes"] or {}
            if q["fails"]:
                for s in team:
                    sus[s] += 2.0 * q["fails"] / len(team)
                sus[final["leader"]] += 0.5
                for s, v in votes.items():
                    if v and s not in team:
                        sus[s] += 0.35
            else:
                for s in team:
                    sus[s] -= 0.4
                # 坏人常常反对“干净”的车
                for s, v in votes.items():
                    if not v:
                        sus[s] += 0.35
        for rec in g.lady_log:
            if rec["claim"] and rec["holder"] != self.seat:
                sus[rec["target"]] += 0.6 if rec["claim"] == EVIL else -0.3
        return sus

    def belief(self) -> dict[int, float]:
        sus = self.public_suspicion()
        for s, t in self.game.known_alignments(self.seat).items():
            if t == EVIL:
                sus[s] += 10
            elif t == GOOD:
                sus[s] -= 10
            elif t == "merlin?":
                sus[s] -= 0.5
        if not self.evil:
            sus[self.seat] = -100
        return sus

    def _noisy(self, scores: dict[int, float]) -> dict[int, float]:
        return {s: v + self.rng.uniform(0, 0.25) for s, v in scores.items()}

    # ------------------------------------------------------------- 组队与投票
    def _choose_team(self, size: int) -> list[int]:
        g = self.game
        if not self.evil:
            belief = self._noisy(self.belief())
            others = sorted((s for s in g.seats if s != self.seat), key=lambda s: belief[s])
            return sorted([self.seat] + others[: size - 1])
        mates = self.mates()
        pub = self._noisy(self.public_suspicion())
        goods = sorted((s for s in g.seats if s not in mates), key=lambda s: pub[s])
        team = [self.seat]
        q = g.quests[g.quest_index]
        if q["fails_needed"] >= 2:
            others = sorted((s for s in mates if s != self.seat), key=lambda s: pub[s])
            team += others[:1]
        team += goods[: size - len(team)]
        if len(team) < size:
            rest = [s for s in g.seats if s not in team]
            team += rest[: size - len(team)]
        return sorted(team[:size])

    def _intend_vote(self, team: list[int]) -> bool:
        g = self.game
        if g.leader == self.seat:
            return True
        if self.evil and self.me.role != "oberon":
            if any(s in self.mates() for s in team):
                return True
            return False
        if self.me.role == "oberon" and self.seat in team:
            return True
        known = g.known_alignments(self.seat)
        if any(known.get(s) == EVIL for s in team):
            # 梅林偶尔放水，避免票型太准被刺客抓到
            _, evil_wins = g.score()
            if self.me.role != "merlin" or g.attempt >= 4 or evil_wins >= 2:
                return False
            return self.rng.random() < (0.4 if evil_wins == 0 else 0.2)
        if g.attempt >= 5:
            return True
        belief = self.belief()
        worst = max((belief[s] for s in team if s != self.seat), default=0.0)
        if g.quest_index == 0 and worst <= 0:
            return self.seat in team or self.rng.random() < 0.6
        return worst < (0.9 if self.seat in team else 0.15)

    def propose(self, size: int) -> Decision:
        team = self._choose_team(size)
        line = self.rng.choice(
            [
                f"这轮我带{_fmt(team)}，目前看这几位最可信。",
                f"我提议{_fmt(team)}，大家看看有没有问题。",
                f"{_fmt(team)}，先这么发车，有意见可以提。",
            ]
        )
        return Decision(team, speech=line, thought="离线策略：选择我认为最干净的人组队。")

    def speak(self, team: list[int]) -> Decision:
        if self.rng.random() < 0.12:
            return Decision(None, speech=self.rng.choice(["过。", "没什么补充，听后面的。"]))
        will = self._intend_vote(team)
        pub = self.public_suspicion()
        worst = max((s for s in team if s != self.seat), key=lambda s: pub[s], default=None)
        if will:
            pool = [
                "这个车我觉得可以，先跑一下看看。",
                f"{_fmt(team)}目前看都还算干净，我同意。",
                "我没什么意见，这车能走。",
            ]
            if self.seat in team:
                pool.append("我在车上，我肯定出成功，这车可以走。")
        else:
            x = worst if worst is not None else team[0]
            pool = [
                f"{x}号我不太放心，这车我倾向反对。",
                f"{x}号之前的表现有点问题，换个人我再考虑。",
                "这个队伍我不太认，建议换人。",
            ]
        return Decision(None, speech=self.rng.choice(pool), thought=f"离线策略：倾向{'赞成' if will else '反对'}。")

    def vote(self, team: list[int]) -> Decision:
        will = self._intend_vote(team)
        return Decision(will, thought=f"离线策略：{'赞成' if will else '反对'}。")

    def quest(self, team: list[int]) -> Decision:
        if not self.evil:
            return Decision("success")
        g = self.game
        q = g.quests[g.quest_index]
        if self.me.role == "oberon" or q["fails_needed"] >= 2:
            return Decision("fail", thought="离线策略：出失败。")
        mates_on = sorted(s for s in team if s in self.mates())
        if mates_on and mates_on[0] != self.seat:
            return Decision("success", thought="离线策略：同车队友座位号更小，由他出失败。")
        _, evil_wins = g.score()
        if g.quest_index == 0 and evil_wins == 0 and self.rng.random() < 0.3:
            return Decision("success", thought="离线策略：第一轮先藏一下。")
        return Decision("fail", thought="离线策略：出失败。")

    # ------------------------------------------------------------- 湖中仙女
    def lady_choose(self, candidates: list[int]) -> Decision:
        if self.evil:
            mates = self.mates()
            pool = [s for s in candidates if s not in mates] or candidates
            return Decision(self.rng.choice(pool))
        known = self.game.known_alignments(self.seat)
        belief = self._noisy(self.belief())
        pool = [s for s in candidates if s not in known] or candidates
        return Decision(max(pool, key=lambda s: belief[s]))

    def lady_announce(self, target: int, result: str) -> Decision:
        claim = result
        if self.evil:
            if target in self.mates():
                claim = GOOD
            elif self.rng.random() < 0.4:
                claim = EVIL
        word = "好人" if claim == GOOD else "坏人"
        return Decision(claim, speech=f"我查验了{target}号，结果是{word}。", thought="离线策略。")

    # ------------------------------------------------------------- 刺杀
    def merlin_scores(self, candidates: list[int]) -> dict[int, float]:
        g = self.game
        evil = set(g.evil_seats())
        score = {s: 0.0 for s in candidates}
        for q in g.quests:
            for a in q["attempts"]:
                if a["votes"] is None:
                    continue
                has_evil = any(s in evil for s in a["team"])
                for s in candidates:
                    v = a["votes"][s]
                    if has_evil:
                        score[s] += 1.0 if not v else -0.7
                    else:
                        score[s] += 0.2 if v else -0.2
                if a["leader"] in score:
                    score[a["leader"]] += -1.0 if has_evil else 0.3
        # 票型推理并不可靠，加入较大的不确定性
        return {s: v + self.rng.uniform(0, 2.0) for s, v in score.items()}

    def assassin_suggest(self, candidates: list[int]) -> Decision:
        scores = self.merlin_scores(candidates)
        t = max(candidates, key=lambda s: scores[s])
        return Decision(t, speech=f"我觉得{t}号最像梅林，票型太准了。", thought="离线策略：按票型找梅林。")

    def assassinate(self, candidates: list[int]) -> Decision:
        scores = self.merlin_scores(candidates)
        t = max(candidates, key=lambda s: scores[s])
        return Decision(t, speech=f"我刺{t}号。", thought="离线策略：按票型找梅林。")


def default_brain_factory(game: "Game", player: "Player"):
    if player.is_human:
        return HumanBrain(game, player.seat)
    return HeuristicBrain(game, player.seat)

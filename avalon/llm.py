"""由 DeepSeek 驱动的 AI 玩家。调用失败时自动退回离线规则AI。"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Callable

from .brains import Decision, HeuristicBrain
from .deepseek import DeepSeekClient, LLMError, extract_json
from .prompts import system_prompt, user_prompt
from .rules import EVIL, GOOD, TEAM_NAMES

if TYPE_CHECKING:
    from .engine import Game

APPROVE = {"赞成", "同意", "支持", "approve", "yes", "true", "通过", "y"}
REJECT = {"反对", "否决", "不同意", "reject", "no", "false", "n"}


def _seats(seats) -> str:
    return "、".join(f"{s}号" for s in sorted(seats))


def _to_seat(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError
    if isinstance(v, (int, float)):
        return int(v)
    m = re.search(r"\d+", str(v))
    if not m:
        raise ValueError
    return int(m.group())


class LLMBrain:
    def __init__(self, game: "Game", seat: int, client: DeepSeekClient):
        self.game = game
        self.seat = seat
        self.client = client
        self.fallback = HeuristicBrain(game, seat)
        self.system = system_prompt(game, seat)
        self.memory: list[tuple[str, str]] = []

    # ------------------------------------------------------------------ 核心调用
    def _call(self, label: str, task: str, schema: str, parse: Callable[[dict], Decision], fallback: Callable[[], Decision]) -> Decision:
        messages = [
            {"role": "system", "content": self.system},
            {"role": "user", "content": user_prompt(self.game, self.seat, self.memory, task, schema)},
        ]
        error = ""
        for _ in range(2):
            try:
                raw = self.client.chat(messages, json_mode=True, temperature=1.0, max_tokens=900)
            except LLMError as e:
                error = str(e)
                break
            try:
                data = extract_json(raw)
                dec = parse(data)
                dec.thought = str(data.get("thought") or "").strip()[:800]
                if dec.thought:
                    self.memory.append((label, dec.thought))
                return dec
            except (ValueError, TypeError, KeyError) as e:
                error = f"输出格式不正确：{e}"
                messages = messages + [
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": f"你的输出有问题：{e}。请严格按照要求重新输出一个合法的 JSON 对象。"},
                ]
        self.game.note_ai_failure(self.seat, error)
        dec = fallback()
        dec.fallback = True
        return dec

    @staticmethod
    def _speech(data: dict) -> str:
        return str(data.get("speech") or "").strip()[:400]

    def _parse_target(self, data: dict, candidates: list[int]) -> int:
        try:
            t = _to_seat(data.get("target"))
        except ValueError:
            raise ValueError("target 必须是一个座位号")
        if t not in candidates:
            raise ValueError(f"target 必须是以下座位之一：{_seats(candidates)}")
        return t

    def _label(self, what: str) -> str:
        return f"第{self.game.quest_index + 1}轮第{self.game.attempt}次提名·{what}"

    # ------------------------------------------------------------------ 决策
    def propose(self, size: int) -> Decision:
        n = self.game.n

        def parse(data: dict) -> Decision:
            raw = data.get("team")
            if isinstance(raw, str):
                raw = re.findall(r"\d+", raw)
            if not isinstance(raw, list):
                raise ValueError("team 必须是座位号数组")
            team = []
            for v in raw:
                s = _to_seat(v)
                if not 1 <= s <= n:
                    raise ValueError(f"座位号必须在1~{n}之间")
                if s not in team:
                    team.append(s)
            if len(team) != size:
                raise ValueError(f"team 必须恰好包含{size}个不同的座位号")
            return Decision(sorted(team), speech=self._speech(data))

        task = (
            f"你是本次的队长，请提名{size}名玩家（可以包含你自己）去做第{self.game.quest_index + 1}轮任务，"
            "并发言向大家解释你的组队理由。"
        )
        if self.game.attempt >= 5:
            task += "注意：这已经是本轮第5次提名，如果再被否决坏人直接获胜！"
        schema = '{"thought": "内心推理", "team": [座位号, ...], "speech": "你的发言"}'
        return self._call(self._label("当队长"), task, schema, parse, lambda: self.fallback.propose(size))

    def speak(self, team: list[int]) -> Decision:
        leader = self.game.leader
        task = (
            f"队长{leader}号提名了 {_seats(team)}。按座位顺序轮到你发言："
            "表明你对这个队伍的态度，并给出你的分析（可以质疑、支持、点名可疑的人，或者简单地过）。"
        )
        if self.seat in team:
            task += "你自己在这个队伍里。"
        schema = '{"thought": "内心推理", "speech": "你的发言"}'

        def parse(data: dict) -> Decision:
            return Decision(None, speech=self._speech(data))

        return self._call(self._label("发言"), task, schema, parse, lambda: self.fallback.speak(team))

    def vote(self, team: list[int]) -> Decision:
        g = self.game
        task = f"发言结束。现在对队长{g.leader}号提名的队伍 {_seats(team)} 进行投票（所有人同时亮票）。"
        if g.attempt >= 5:
            task += "这是本轮第5次提名：如果被否决，坏人直接获胜！"
        elif g.attempt == 4:
            task += "这是本轮第4次提名，否决次数已经不少了。"
        schema = '{"thought": "内心推理", "vote": "赞成" 或 "反对"}'

        def parse(data: dict) -> Decision:
            v = str(data.get("vote", "")).strip().lower()
            if v in APPROVE:
                return Decision(True)
            if v in REJECT:
                return Decision(False)
            raise ValueError("vote 只能是“赞成”或“反对”")

        return self._call(self._label("投票"), task, schema, parse, lambda: self.fallback.vote(team))

    def quest(self, team: list[int]) -> Decision:
        g = self.game
        if g.team_of_seat(self.seat) == GOOD:
            return Decision("success")
        q = g.quests[g.quest_index]
        mates = [s for s, _ in g.knowledge(self.seat)]
        mates_on = [s for s in team if s in mates]
        good, evil = g.score()
        task = (
            f"你在第{q['index'] + 1}轮任务的队伍里，队员：{_seats(team)}。本轮需要{q['fails_needed']}张失败牌任务才会失败。"
            f"当前比分 好人{good} : {evil}坏人。你是坏人，秘密选择出“成功”还是“失败”。"
        )
        if mates_on:
            task += f"你已知的坏人队友{_seats(mates_on)}也在车上。"
        schema = '{"thought": "内心推理", "card": "成功" 或 "失败"}'

        def parse(data: dict) -> Decision:
            c = str(data.get("card", "")).strip().lower()
            if c in ("成功", "success"):
                return Decision("success")
            if c in ("失败", "fail", "failure"):
                return Decision("fail")
            raise ValueError("card 只能是“成功”或“失败”")

        return self._call(f"第{q['index'] + 1}轮·出任务", task, schema, parse, lambda: self.fallback.quest(team))

    def lady_choose(self, candidates: list[int]) -> Decision:
        task = f"你持有湖中仙女，可以秘密查验一名玩家的真实阵营。可选：{_seats(candidates)}。选择你要查验的人。"
        schema = '{"thought": "内心推理", "target": 座位号}'

        def parse(data: dict) -> Decision:
            return Decision(self._parse_target(data, candidates))

        return self._call("湖中仙女·选择", task, schema, parse, lambda: self.fallback.lady_choose(candidates))

    def lady_announce(self, target: int, result: str) -> Decision:
        task = (
            f"你用湖中仙女查验了{target}号，真实结果：{target}号是【{TEAM_NAMES[result]}】（只有你知道）。"
            "现在请公开宣布结果（可以说真话，也可以撒谎），并发言。"
        )
        schema = '{"thought": "内心推理", "claim": "好人" 或 "坏人", "speech": "你的发言"}'

        def parse(data: dict) -> Decision:
            c = str(data.get("claim", "")).strip().lower()
            if c in ("好人", "good"):
                return Decision(GOOD, speech=self._speech(data))
            if c in ("坏人", "evil"):
                return Decision(EVIL, speech=self._speech(data))
            raise ValueError("claim 只能是“好人”或“坏人”")

        return self._call(
            "湖中仙女·公布", task, schema, parse, lambda: self.fallback.lady_announce(target, result)
        )

    def assassin_suggest(self, candidates: list[int]) -> Decision:
        assassin = self.game.seat_of_role("assassin")
        task = (
            f"好人完成了3次任务，坏人已经亮明身份。现在坏人一起讨论谁是梅林，最终由刺客{assassin}号决定刺谁。"
            f"候选（所有好人）：{_seats(candidates)}。回顾整局的票型、组队和发言，说出你认为谁是梅林以及理由。"
        )
        schema = '{"thought": "内心推理", "target": 座位号, "speech": "你对队友说的话"}'

        def parse(data: dict) -> Decision:
            return Decision(self._parse_target(data, candidates), speech=self._speech(data))

        return self._call("刺杀讨论", task, schema, parse, lambda: self.fallback.assassin_suggest(candidates))

    def assassinate(self, candidates: list[int]) -> Decision:
        task = (
            "好人完成了3次任务，你是刺客，现在由你最终决定刺杀谁。队友们的意见见对局记录最后。"
            f"候选：{_seats(candidates)}。刺中梅林坏人就翻盘获胜。仔细回顾谁的票型最准、谁在暗中引导好人。"
        )
        schema = '{"thought": "内心推理", "target": 座位号, "speech": "刺杀前说的话"}'

        def parse(data: dict) -> Decision:
            return Decision(self._parse_target(data, candidates), speech=self._speech(data))

        return self._call("刺杀", task, schema, parse, lambda: self.fallback.assassinate(candidates))


def make_brain_factory(client: DeepSeekClient):
    from .brains import HumanBrain

    def factory(game, player):
        if player.is_human:
            return HumanBrain(game, player.seat)
        return LLMBrain(game, player.seat, client)

    return factory

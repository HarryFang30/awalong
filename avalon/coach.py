"""教练：对局中的提示（只用你能看到的信息）和赛后复盘（上帝视角）。"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .brains import HeuristicBrain
from .deepseek import DeepSeekClient, LLMError
from .prompts import knowledge_text, render_history, rules_text, state_text
from .rules import EVIL, GOOD, TEAM_NAMES

if TYPE_CHECKING:
    from .engine import Game


def _seats(seats) -> str:
    return "、".join(f"{s}号" for s in sorted(seats)) if seats else "无"


# ---------------------------------------------------------------------- 统计
def compute_stats(game: "Game") -> dict[int, dict]:
    """每位玩家的投票/组队/出牌数据（以“车上有没有坏人”为标准）。"""
    evil = set(game.evil_seats())
    stats = {
        s: {"votes": 0, "correct": 0, "approve_evil": 0, "reject_clean": 0, "proposals": 0, "proposals_with_evil": 0, "fails_played": 0}
        for s in game.seats
    }
    for q in game.quests:
        for a in q["attempts"]:
            has_evil = any(s in evil for s in a["team"])
            st = stats[a["leader"]]
            st["proposals"] += 1
            st["proposals_with_evil"] += int(has_evil)
            if not a["votes"]:
                continue
            for s, v in a["votes"].items():
                st = stats[s]
                st["votes"] += 1
                if v == (not has_evil):
                    st["correct"] += 1
                elif v:
                    st["approve_evil"] += 1
                else:
                    st["reject_clean"] += 1
        for s, c in (q.get("cards") or {}).items():
            if c == "fail":
                stats[s]["fails_played"] += 1
    return stats


def stats_text(game: "Game", seat: int) -> str:
    st = compute_stats(game)[seat]
    if not st["votes"]:
        return "没有投票数据。"
    acc = round(100 * st["correct"] / st["votes"])
    lines = [
        f"- 投票 {st['votes']} 次，“好人视角正确率” {acc}%（赞成无坏人的车、反对有坏人的车算正确）",
        f"- 赞成了含坏人的车 {st['approve_evil']} 次；反对了全是好人的车 {st['reject_clean']} 次",
        f"- 当队长 {st['proposals']} 次，其中提名的队伍含坏人 {st['proposals_with_evil']} 次",
    ]
    if game.team_of_seat(seat) == EVIL:
        lines.append(f"- 出失败牌 {st['fails_played']} 次")
    return "\n".join(lines)


# ---------------------------------------------------------------------- 提示
PENDING_DESC = {
    "propose": "作为队长提名{size}人的任务队伍并发言",
    "speak": "对队伍 {team} 发言",
    "vote": "对队伍 {team} 投票",
    "quest": "在任务中出牌",
    "lady_choose": "用湖中仙女选择查验对象",
    "lady_announce": "公布湖中仙女的查验结果",
    "assassin_suggest": "和坏人队友讨论谁是梅林",
    "assassinate": "作为刺客决定刺杀谁",
}


def _pending_text(game: "Game") -> str:
    p = game.pending
    if not p:
        return "暂时没有轮到学员行动，请分析当前局势。"
    tmpl = PENDING_DESC.get(p["type"], "行动")
    return "学员现在需要：" + tmpl.format(size=p.get("size", ""), team=_seats(p.get("team") or []))


def _alignment_lines(game: "Game", seat: int) -> list[str]:
    brain = HeuristicBrain(game, seat)
    belief = brain.belief() if game.team_of_seat(seat) == GOOD else brain.public_suspicion()
    known = game.known_alignments(seat)
    lines = []
    for s in sorted(game.seats, key=lambda x: -belief[x]):
        if s == seat:
            continue
        if known.get(s) == EVIL:
            tag = "确定是坏人"
        elif known.get(s) == GOOD:
            tag = "确定是好人"
        elif known.get(s) == "merlin?":
            tag = "梅林或莫甘娜"
        elif belief[s] > 0.6:
            tag = "嫌疑较大"
        elif belief[s] < -0.3:
            tag = "相对干净"
        else:
            tag = "信息不足"
        lines.append(f"- {s}号：{tag}（怀疑分 {belief[s]:.1f}）")
    return lines


def offline_hint(game: "Game") -> str:
    seat = game.human_seat
    lines = ["**离线教练**（未配置 DeepSeek，只根据任务结果和已知信息做简单计算）", "", "**身份倾向：**"]
    lines += _alignment_lines(game, seat)
    p = game.pending
    if p and p["type"] in ("vote", "speak") and p.get("team"):
        will = HeuristicBrain(game, seat)._intend_vote(p["team"])
        lines += ["", f"**建议：** 对这个队伍倾向投{'赞成' if will else '反对'}。"]
    elif p and p["type"] == "propose":
        team = HeuristicBrain(game, seat)._choose_team(p["size"])
        lines += ["", f"**建议组队：** {_seats(team)}"]
    lines += ["", "**技巧：** 每次任务失败后，把车上的人和投赞成票的人都记下来，坏人往往会反复支持有队友的车。"]
    return "\n".join(lines)


def hint(game: "Game", client: Optional[DeepSeekClient]) -> str:
    seat = game.human_seat
    if seat is None:
        return "没有人类玩家。"
    if client is None or client.disabled_reason:
        return offline_hint(game)
    me = game.players[seat]
    system = (
        "你是一位经验丰富、善于教学的《阿瓦隆》桌游教练，正在旁边指导学员实战。"
        "你只能使用学员视角能看到的信息（公开信息 + 学员自己的身份信息），不能假装知道别人的底牌，不要编造没发生的事。"
    )
    user = f"""## 规则
{rules_text(game)}

## 学员信息
学员是{seat}号，身份【{me.role_name}】（{TEAM_NAMES[me.team]}）。{knowledge_text(game, seat)}

## 对局记录（学员视角）
{render_history(game, seat) or '（暂无）'}

{state_text(game)}

## 当前
{_pending_text(game)}

请用简洁的中文（350字以内，markdown）给出：
1. **局势判断**：一两句话。
2. **身份推测**：只列有信号的玩家，给出倾向和一句话依据。
3. **行动建议**：针对学员现在要做的事，给出具体建议（例如组谁、投什么、发言说什么），说明理由；如果学员是坏人或梅林，也要提醒怎么隐藏身份。
4. **技巧点**：一个此刻值得学习的阿瓦隆技巧。"""
    try:
        return client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.7,
            max_tokens=1200,
        )
    except LLMError as e:
        return f"（教练暂时连不上：{e}）\n\n" + offline_hint(game)


# ---------------------------------------------------------------------- 复盘
def roles_reveal_text(game: "Game") -> str:
    lines = []
    for s, p in game.players.items():
        tag = " ← 学员" if p.is_human else ""
        lines.append(f"- {s}号「{p.name}」：{p.role_name}（{TEAM_NAMES[p.team]}）{tag}")
    return "\n".join(lines)


def offline_review(game: "Game") -> str:
    seat = game.human_seat
    if seat is None:
        return "\n".join([f"**结果：** {game.end_reason}", "", "**身份揭晓：**", roles_reveal_text(game),
                          "", "配置 DeepSeek API Key 后可以获得 AI 教练的整局点评。"])
    me = game.players[seat]
    won = game.winner == me.team
    lines = [
        f"**结果：** {'你赢了！' if won else '这局输了。'} {game.end_reason}",
        "",
        f"**你的数据（{me.role_name}）：**",
        stats_text(game, seat),
        "",
        "**身份揭晓：**",
        roles_reveal_text(game),
        "",
        "配置 DeepSeek API Key 后可以获得 AI 教练的详细复盘。",
    ]
    return "\n".join(lines)


def spectator_review(game: "Game", client: DeepSeekClient) -> str:
    system = (
        "你是一位《阿瓦隆》解说兼教练。观众刚刚完整观看了一局 AI 之间的对局（上帝视角），"
        "请帮观众从中学到可以用在自己对局里的技巧。点评要具体到第几轮的哪个决策。"
    )
    user = f"""## 规则
{rules_text(game)}

## 身份揭晓
{roles_reveal_text(game)}

## 完整对局记录（上帝视角）
{render_history(game, None, god=True)}

## 要求
用 markdown 写一篇900字以内的整局点评，包含以下小节：
### 胜负关键
### 好人阵营：做对了什么、错在哪里
### 坏人阵营：伪装和配合的亮点与破绽
### 梅林与刺客的博弈
### 值得学习的三个技巧"""
    try:
        return client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.7,
            max_tokens=2000,
        )
    except LLMError as e:
        return f"（教练暂时连不上：{e}）\n\n" + offline_review(game)


def review(game: "Game", client: Optional[DeepSeekClient]) -> str:
    seat = game.human_seat
    if client is None or client.disabled_reason:
        return offline_review(game)
    if seat is None:
        return spectator_review(game, client)
    me = game.players[seat]
    system = (
        "你是一位犀利但友善的《阿瓦隆》复盘教练。你拥有上帝视角，请帮助学员从这局游戏中真正学到东西："
        "点评要具体到第几轮的哪个决策，说清楚学员当时能看到哪些信息、本可以怎样做得更好。"
    )
    user = f"""## 规则
{rules_text(game)}

## 身份揭晓
{roles_reveal_text(game)}

## 完整对局记录（上帝视角，含谁出了失败牌、湖中仙女真实结果）
{render_history(game, None, god=True)}

## 学员数据（{seat}号，{me.role_name}）
{stats_text(game, seat)}

## 要求
请对学员（{seat}号，{me.role_name}）的表现做复盘，用 markdown，900字以内，包含以下小节：
### 胜负关键
两三句话讲清这局是怎么赢/输的。
### 你做得好的地方
### 可以改进的地方
具体到第几轮哪个决策（组队/发言/投票/出牌/查验/刺杀），当时能看到什么信号，更好的选择是什么、为什么。
### AI 玩家的亮点
哪位 AI 伪装或推理得好，学员可以借鉴什么。
### 下一局练习重点
1~2 条可执行的建议。"""
    try:
        return client.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.7,
            max_tokens=2000,
        )
    except LLMError as e:
        return f"（教练暂时连不上：{e}）\n\n" + offline_review(game)

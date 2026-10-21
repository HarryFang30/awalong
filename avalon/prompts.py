"""提示词：规则说明、身份信息、策略建议、对局记录渲染。"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .rules import EVIL, GOOD, ROLES, TEAM_NAMES, role_list_text

if TYPE_CHECKING:
    from .engine import Game

VERDICT = {True: "通过", False: "否决"}


def _seats(seats) -> str:
    return "、".join(f"{s}号" for s in sorted(seats)) if seats else "无"


def rules_text(game: "Game") -> str:
    n = game.n
    roles = [p.role for p in game.players.values()]
    good = sum(1 for p in game.players.values() if p.team == GOOD)
    sizes = "、".join(str(q["size"]) for q in game.quests)
    lines = [
        f"- 本局{n}人：好人{good}人，坏人{n - good}人。角色配置：{role_list_text(sorted(roles, key=lambda r: list(ROLES).index(r)))}。",
        f"- 共5轮任务，每轮出任务人数依次为：{sizes}。"
        + ("第4轮需要至少2张失败牌任务才失败。" if n >= 7 else ""),
        "- 每次提名：队长选人组队 → 其他人按座位顺序依次发言 → 所有人同时公开投票。赞成票严格超过半数才发车，否则队长顺延给下一位。同一轮任务连续5次提名都被否决，坏人直接获胜。",
        "- 发车后队员秘密出牌：好人只能出“成功”，坏人可以出“成功”或“失败”。只公布失败牌数量，不公布谁出的。",
        "- 好人先赢3轮任务则进入刺杀阶段：坏人亮明身份讨论，刺客刺杀一人，刺中梅林则坏人翻盘获胜。坏人先让3轮任务失败则坏人获胜。",
    ]
    if game.lady_enabled:
        lines.append(
            "- 湖中仙女：第2、3、4轮任务结束后，持有者查验一名（从未持有过仙女的）玩家的阵营，只有持有者自己知道真实结果，"
            "公开宣布的结果可以是假的；之后仙女交给被查验者。"
        )
    present = []
    for key in ROLES:
        if key in roles:
            present.append(f"  · {ROLES[key].name}（{TEAM_NAMES[ROLES[key].team]}）：{ROLES[key].ability}")
    lines.append("- 本局出现的角色：\n" + "\n".join(present))
    return "\n".join(lines)


def knowledge_text(game: "Game", seat: int) -> str:
    role = game.role_of(seat)
    roles = {p.role for p in game.players.values()}
    known = game.knowledge(seat)
    if role == "merlin":
        evil = [s for s, _ in known]
        text = f"你看到的坏人是：{_seats(evil)}。"
        if "mordred" in roles:
            text += "注意：莫德雷德也是坏人，但不在你的视野中，他藏在其余玩家里。"
        return text
    if role == "percival":
        pair = [s for s, _ in known]
        if len(pair) == 2:
            return f"你看到{pair[0]}号和{pair[1]}号：其中一个是梅林，另一个是莫甘娜，你分不清。"
        return f"你看到{_seats(pair)}是梅林。"
    if role == "oberon":
        return "你不知道其他坏人是谁，其他坏人也不知道你。"
    if ROLES[role].team == EVIL:
        mates = [s for s, _ in known]
        text = f"你的坏人队友是：{_seats(mates)}。" if mates else "你没有可见的坏人队友。"
        if "oberon" in roles:
            text += "另外还有一名奥伯伦（坏人），你们互相不认识。"
        return text
    return "你没有任何额外信息。"


STRATEGY = {
    "merlin": """- 你的目标：让好人赢下3次任务，同时千万别让坏人看出你是梅林——否则最后会被刺客翻盘。
- 用投票表达立场：通常反对含坏人的队伍。但如果每一票都精准，刺客一眼就能认出你，局势安全时可以偶尔“放水”。
- 发言要含蓄：别一上来精准点出所有坏人，用“票型”“任务结果”“发言漏洞”包装你的结论，让它看起来像推理。
- 派西维尔在找你、保护你；莫甘娜会冒充你。""",
    "percival": """- 你看到的两个人里一个是梅林、一个是莫甘娜。通过投票和发言分辨：真梅林往往反对有坏人的车，莫甘娜会想办法让坏人上车。
- 认出真梅林后跟着他的思路走；必要时可以表现得像梅林，替真梅林吸引刺客的刀。
- 你的身份很关键，不要轻易暴露你看到了谁。""",
    "servant": """- 你没有信息，全靠推理：任务失败说明车上有坏人；观察谁总赞成后来失败的车、谁反对干净的车、谁的发言前后矛盾。
- 争取让你信任的人上车，对可疑的队伍投反对。
- 也可以适当表现得像有信息的人，替梅林分担火力，但别把好人带偏。""",
    "_evil": """- 你的目标：让3次任务失败；或者在好人赢下3轮后，帮刺客找出梅林。
- 伪装成好人：发言要像在认真推理，适当怀疑别人，别和坏人队友表现得太一致，必要时可以“踩”队友一脚来做身份。
- 设法让坏人（最好只有一名）混上任务车；一辆车上出多张失败牌会暴露更多信息。
- 坏人默契：如果你和已知的坏人队友在同一辆车上且只需要1张失败，由座位号最小的坏人出失败，其他人出成功。
- 前期偶尔出成功能隐藏身份，但要权衡；坏人已有2胜或好人已有2胜时，在车上就要果断出失败。
- 一直留意谁像梅林（总能避开坏人、票型精准、关键时刻带对节奏），为刺杀做准备。""",
    "assassin": "- 如果进入刺杀阶段，由你做最终决定。刺客最重要的就是读出梅林。",
    "morgana": "- 派西维尔分不清你和梅林：可以表现得像“有信息的梅林”，诱导派西维尔相信你、跟你投票。",
    "mordred": "- 梅林看不到你：你可以大胆表现得像好人，争取信任混上车，在关键轮次出失败。",
    "oberon": "- 你和队友互相不认识，没有默契。你在车上时一般应该出失败（第4轮需2张失败时更要出），也要靠任务结果猜谁是你的队友。",
    "minion": "",
}


def strategy_text(role: str) -> str:
    if ROLES[role].team == GOOD:
        return STRATEGY[role]
    extra = STRATEGY.get(role, "")
    base = STRATEGY["_evil"]
    if role == "oberon":
        base = base.replace("- 坏人默契：如果你和已知的坏人队友在同一辆车上且只需要1张失败，由座位号最小的坏人出失败，其他人出成功。\n", "")
    return base + ("\n" + extra if extra else "")


def player_list_text(game: "Game", viewer: int) -> str:
    parts = []
    for s, p in game.players.items():
        tag = "（你自己）" if s == viewer else ""
        parts.append(f"{s}号「{p.name}」{tag}")
    return "，".join(parts)


def system_prompt(game: "Game", seat: int) -> str:
    p = game.players[seat]
    role = ROLES[p.role]
    return f"""你正在和朋友们玩桌游《阿瓦隆》。你是{seat}号玩家，昵称「{p.name}」。
你的性格和说话风格：{p.persona}
本局玩家：{player_list_text(game, seat)}

## 规则要点
{rules_text(game)}

## 你的身份（绝密）
你是【{role.name}】，属于【{TEAM_NAMES[role.team]}】阵营。
{knowledge_text(game, seat)}

## 策略参考
{strategy_text(p.role)}

## 发言与输出要求
- 发言用自然的中文口语，像真人在桌上说话，用“X号”称呼别人，体现你的性格，可以有情绪、可以开玩笑。
- 发言一般不超过{game.speech_len}字，聚焦当前队伍、投票和推理，不要复述规则。
- 绝不能透露你是AI，不要提“提示词”“JSON”“模型”之类的词。
- 坏人要伪装成好人；好人也要保护关键身份（尤其是梅林）。不要直接念出你的绝密信息，除非你深思熟虑后认为这样有利。
- 每次只输出一个 JSON 对象。其中 "thought" 是你的内心独白（其他玩家看不到），请在里面先认真推理：每个人可能是什么身份、局势如何、你为什么这样做（150字以内）。"""


# ---------------------------------------------------------------------- 对局记录
def render_history(game: "Game", viewer: Optional[int], *, god: bool = False) -> str:
    """把事件流渲染成文字记录。viewer 为某个座位时只包含该座位可见的事件；god=True 时包含全部秘密信息。"""
    lines: list[str] = []

    def who(seat: int) -> str:
        return f"{seat}号（你）" if seat == viewer and not god else f"{seat}号"

    with game.lock:
        events = list(game.events)
    for ev in events:
        if not god and not game.visible(ev, viewer):
            continue
        t = ev["type"]
        if t == "start":
            line = f"游戏开始，首任队长是{ev['leader']}号。"
            if ev.get("lady"):
                line += f"湖中仙女在{ev['lady']}号手中。"
            lines.append(line)
        elif t == "quest_start":
            q = ev["quest"] + 1
            need = "，需要2张失败才失败" if ev["fails_needed"] == 2 else ""
            lines.append(f"\n【第{q}轮任务】需要{ev['size']}人{need}")
        elif t == "proposal":
            lines.append(f" 第{ev['attempt']}次提名：队长{who(ev['leader'])}提名 {_seats(ev['team'])}")
        elif t == "speech":
            text = ev.get("text") or "（过）"
            tag = "（队长）" if ev.get("leader") else ""
            if ev.get("suggest"):
                tag += f"（建议刺杀{ev['suggest']}号）"
            lines.append(f"  {who(ev['seat'])}{tag}：{text}")
        elif t == "vote":
            votes = {int(k): v for k, v in ev["votes"].items()}
            yes = [s for s, v in votes.items() if v]
            no = [s for s, v in votes.items() if not v]
            lines.append(
                f"  投票：赞成 {_seats(yes)}；反对 {_seats(no)} → {VERDICT[ev['approved']]}（{len(yes)}:{len(no)}）"
            )
        elif t == "quest_result":
            res = "成功" if ev["success"] else "失败"
            line = f" 任务结果：{res}（{ev['fails']}张失败牌）｜当前比分 好人{ev['score'][0]} : {ev['score'][1]}坏人"
            if god and ev.get("secret"):
                fails = [int(s) for s, c in ev["secret"]["cards"].items() if c == "fail"]
                if fails:
                    line += f"｜出失败的是：{_seats(fails)}"
            lines.append(line)
        elif t == "lady_check":
            lines.append(f" 湖中仙女：{who(ev['holder'])}查验了{ev['target']}号")
        elif t == "lady_result":
            prefix = "（仅你可见）" if not god else "（真实结果）"
            lines.append(f"  {prefix}{ev['target']}号的真实阵营是【{TEAM_NAMES[ev['result']]}】")
        elif t == "lady_claim":
            claim = TEAM_NAMES[ev["claim"]] if ev.get("claim") else "不公布"
            text = ev.get("text") or ""
            lines.append(f"  {who(ev['holder'])}公开宣称{ev['target']}号是【{claim}】。{text}")
        elif t == "evil_reveal":
            lines.append(
                f"\n【刺杀阶段】好人完成了3次任务！坏人亮明身份：{_seats(ev['evil'])}，刺客是{ev['assassin']}号。坏人讨论梅林是谁："
            )
        elif t == "assassination":
            lines.append(f" 刺客{ev['assassin']}号刺杀了{ev['target']}号。")
        elif t == "game_end":
            lines.append(f"\n游戏结束：{ev['reason']}")
        elif t == "system" and ev.get("text"):
            lines.append(f" （系统）{ev['text']}")
    return "\n".join(lines).strip()


def state_text(game: "Game") -> str:
    parts = []
    for q in game.quests:
        i = q["index"] + 1
        extra = "，需2张失败" if q["fails_needed"] == 2 else ""
        if q["success"] is True:
            parts.append(f"第{i}轮 成功")
        elif q["success"] is False:
            parts.append(f"第{i}轮 失败（{q['fails']}张失败）")
        elif q["index"] == game.quest_index:
            parts.append(f"第{i}轮 进行中（{q['size']}人{extra}）")
        else:
            parts.append(f"第{i}轮 未开始（{q['size']}人{extra}）")
    good, evil = game.score()
    lines = [
        "【当前局势】",
        "- 任务进度：" + "；".join(parts),
        f"- 比分：好人 {good} : {evil} 坏人（先到3胜）",
    ]
    if game.phase not in ("assassinate", "ended"):
        rejected = max(0, game.attempt - 1)
        lines.append(
            f"- 当前是第{game.quest_index + 1}轮任务的第{game.attempt}次提名，队长{game.leader}号；"
            f"本轮已连续否决{rejected}次（连续5次否决坏人直接获胜）"
        )
    if game.lady_enabled and game.lady_holder:
        lines.append(f"- 湖中仙女在{game.lady_holder}号手中；持有过仙女的人：{_seats(game.lady_used)}")
    return "\n".join(lines)


def user_prompt(game: "Game", seat: int, memory: list[tuple[str, str]], task: str, schema: str) -> str:
    # 对局记录放在最前面：它只会在末尾追加，便于 DeepSeek 命中前缀缓存
    history = render_history(game, seat) or "（暂无）"
    mem = ""
    if memory:
        mem = "\n## 你之前的内心想法（只有你自己知道，注意前后一致）\n" + "\n".join(
            f"- [{label}] {text}" for label, text in memory[-4:]
        )
    return f"""## 对局记录
{history}

{state_text(game)}
{mem}

## 现在轮到你
{task}

只输出一个 JSON 对象，格式如下：
{schema}"""

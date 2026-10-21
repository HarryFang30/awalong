"""阿瓦隆规则常量：角色、人数配置、任务人数、视野。"""
from __future__ import annotations

from dataclasses import dataclass

GOOD = "good"
EVIL = "evil"

TEAM_NAMES = {GOOD: "好人", EVIL: "坏人"}


@dataclass(frozen=True)
class Role:
    key: str
    name: str
    team: str
    ability: str


ROLES: dict[str, Role] = {
    "merlin": Role("merlin", "梅林", GOOD, "知道除莫德雷德以外的所有坏人；若好人赢下3次任务后被刺客刺中，坏人翻盘。"),
    "percival": Role("percival", "派西维尔", GOOD, "能看到梅林和莫甘娜两个人，但分不清谁是谁。"),
    "servant": Role("servant", "忠臣", GOOD, "没有任何额外信息，只能靠推理。"),
    "assassin": Role("assassin", "刺客", EVIL, "认识坏人队友；好人赢下3次任务后，由刺客刺杀梅林翻盘。"),
    "morgana": Role("morgana", "莫甘娜", EVIL, "认识坏人队友；在派西维尔眼里和梅林长得一样。"),
    "mordred": Role("mordred", "莫德雷德", EVIL, "认识坏人队友；梅林看不到你。"),
    "oberon": Role("oberon", "奥伯伦", EVIL, "坏人，但不认识队友，队友也不认识你；梅林能看到你。"),
    "minion": Role("minion", "爪牙", EVIL, "普通坏人，认识坏人队友。"),
}

# 常见的标准配置
PRESETS: dict[int, list[str]] = {
    5: ["merlin", "percival", "servant", "morgana", "assassin"],
    6: ["merlin", "percival", "servant", "servant", "morgana", "assassin"],
    7: ["merlin", "percival", "servant", "servant", "morgana", "assassin", "oberon"],
    8: ["merlin", "percival", "servant", "servant", "servant", "morgana", "assassin", "minion"],
    9: ["merlin", "percival", "servant", "servant", "servant", "servant", "morgana", "assassin", "mordred"],
    10: ["merlin", "percival", "servant", "servant", "servant", "servant", "morgana", "assassin", "mordred", "oberon"],
}

TEAM_SIZES: dict[int, list[int]] = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
}

MAX_REJECTS = 5
LADY_AFTER_QUESTS = (1, 2, 3)  # 第2、3、4轮任务结束后使用湖中仙女（0 起计）


def fails_required(num_players: int, quest_index: int) -> int:
    """7人及以上的第4轮任务需要2张失败才算失败。"""
    return 2 if num_players >= 7 and quest_index == 3 else 1


def team_of(role_key: str) -> str:
    return ROLES[role_key].team


def knowledge_for(seat: int, roles: dict[int, str]) -> list[tuple[int, str]]:
    """返回某个座位开局时能看到的信息：[(座位, 标签)]。"""
    role = roles[seat]
    known: list[tuple[int, str]] = []
    if role == "merlin":
        for s, r in roles.items():
            if team_of(r) == EVIL and r != "mordred":
                known.append((s, "坏人"))
    elif role == "percival":
        for s, r in roles.items():
            if r in ("merlin", "morgana"):
                known.append((s, "梅林或莫甘娜"))
    elif team_of(role) == EVIL and role != "oberon":
        for s, r in roles.items():
            if s != seat and team_of(r) == EVIL and r != "oberon":
                known.append((s, "坏人队友"))
    return sorted(known)


def role_list_text(role_keys: list[str]) -> str:
    counts: dict[str, int] = {}
    for k in role_keys:
        counts[k] = counts.get(k, 0) + 1
    parts = []
    for k, c in counts.items():
        name = ROLES[k].name
        parts.append(f"{name}×{c}" if c > 1 else name)
    return "、".join(parts)

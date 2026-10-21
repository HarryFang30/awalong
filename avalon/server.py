"""本地 HTTP 服务：提供网页和游戏 API（只用标准库）。"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import threading
import time
import traceback
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from .brains import default_brain_factory
from .coach import compute_stats, hint, review
from .deepseek import DEFAULT_BASE_URL, DEFAULT_MODEL, DeepSeekClient, LLMError
from .engine import Game, InvalidAction
from .llm import make_brain_factory
from .rules import PRESETS, ROLES, TEAM_SIZES

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
RECORDS = ROOT / "records"
MAX_GAMES = 8


def load_dotenv(path: Path) -> None:
    """读取 .env（KEY=VALUE），不覆盖已有环境变量。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


class App:
    def __init__(
        self,
        api_key: str = "",
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        offline_pace: float = 0.9,
        records_dir: Path = RECORDS,
    ):
        self.records_dir = records_dir
        self.api_key = api_key
        self.offline_pace = offline_pace  # 离线 AI 每句话之间的停顿，方便阅读
        self.model = model
        self.base_url = base_url
        self.games: dict[str, Game] = {}
        self.lock = threading.Lock()
        self._busy: set[str] = set()

    # ------------------------------------------------------------------ 配置
    def config(self) -> dict:
        return {
            "has_server_key": bool(self.api_key),
            "model": self.model,
            "presets": {
                str(n): {"roles": roles, "team_sizes": TEAM_SIZES[n]} for n, roles in PRESETS.items()
            },
            "roles": {k: {"name": r.name, "team": r.team, "ability": r.ability} for k, r in ROLES.items()},
        }

    def check_key(self, body: dict) -> dict:
        key = (body.get("api_key") or self.api_key or "").strip()
        if not key:
            return {"ok": False, "message": "没有填写 API Key"}
        client = DeepSeekClient(key, model=body.get("model") or self.model, base_url=self.base_url)
        try:
            models = client.check()
            return {"ok": True, "message": f"连接成功，可用模型：{models}"}
        except LLMError as e:
            return {"ok": False, "message": str(e)}

    # ------------------------------------------------------------------ 对局
    def get(self, game_id: str) -> Game:
        with self.lock:
            game = self.games.get(game_id)
        if not game:
            raise KeyError(game_id)
        return game

    def create_game(self, body: dict) -> dict:
        n = int(body.get("num_players") or 7)
        if n not in PRESETS:
            raise InvalidAction("人数必须在 5~10 之间")
        seat = body.get("seat")
        spectator = seat == "watch"
        seat = int(seat) if seat not in (None, "", "random", "watch") else None
        role = body.get("role") or None
        if role == "random":
            role = None
        if role and role not in PRESETS[n]:
            raise InvalidAction("这个人数没有该角色")
        speech_len = max(30, min(200, int(body.get("speech_len") or 80)))

        client: Optional[DeepSeekClient] = None
        if body.get("mode", "llm") == "llm":
            key = (body.get("api_key") or self.api_key or "").strip()
            if not key:
                raise InvalidAction("请填写 DeepSeek API Key，或者选择“离线规则AI”模式")
            client = DeepSeekClient(key, model=(body.get("model") or self.model).strip(), base_url=self.base_url)

        try:
            game = Game(
                n,
                human=not spectator,
                human_seat=seat,
                human_role=role,
                human_name=str(body.get("name") or "玩家"),
                lady=bool(body.get("lady")),
                speech_len=speech_len,
                pace=0.0 if client else self.offline_pace,
                brain_factory=make_brain_factory(client) if client else default_brain_factory,
                on_finish=self.save_record,
            )
        except ValueError as e:
            raise InvalidAction(str(e))
        game.client = client

        with self.lock:
            # 同一时间只跑一局，旧对局停掉以免浪费 token
            for old in self.games.values():
                if old.status in ("created", "running"):
                    old.cancel()
            self.games[game.id] = game
            while len(self.games) > MAX_GAMES:
                self.games.pop(next(iter(self.games)))
        game.start()
        return {"id": game.id}

    def state(self, game: Game, since: int) -> dict:
        data = game.client_state(since)
        if data["status"] == "ended":
            data["stats"] = {str(s): v for s, v in compute_stats(game).items()}
            data["review"] = game.review_text
        return data

    def hint(self, game: Game) -> dict:
        if game.status != "running":
            raise InvalidAction("对局不在进行中")
        if game.human_seat is None:
            raise InvalidAction("观战模式下没有教练提示")
        return {"text": hint(game, game.client)}

    def review(self, game: Game) -> dict:
        if game.status != "ended":
            raise InvalidAction("对局结束后才能复盘")
        if game.review_text:
            return {"text": game.review_text}
        with self.lock:
            if game.id in self._busy:
                raise InvalidAction("复盘正在生成中，请稍等")
            self._busy.add(game.id)
        try:
            text = review(game, game.client)
            game.review_text = text
            self.save_record(game)
            return {"text": text}
        finally:
            with self.lock:
                self._busy.discard(game.id)

    def save_record(self, game: Game) -> None:
        if game.status != "ended":
            return
        try:
            self.records_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(game.created_at))
            path = self.records_dir / f"{stamp}_{game.n}p_{game.id}.json"
            path.write_text(json.dumps(game.record(), ensure_ascii=False, indent=1), encoding="utf-8")
        except OSError:
            traceback.print_exc()


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Avalon/0.1"

        def log_message(self, fmt, *args):  # 保持终端清爽
            pass

        # -------------------------------------------------------------- 输出
        def _json(self, data, status: int = 200) -> None:
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def _error(self, message: str, status: int = 400) -> None:
            self._json({"error": message}, status)

        def _static(self, rel: str) -> None:
            path = (STATIC / rel).resolve()
            if STATIC.resolve() not in path.parents or not path.is_file():
                return self._error("Not found", 404)
            raw = path.read_bytes()
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(raw)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > 1_000_000:
                raise InvalidAction("请求太大")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise InvalidAction("请求格式错误")
            return data if isinstance(data, dict) else {}

        # -------------------------------------------------------------- 路由
        def do_GET(self):
            url = urlparse(self.path)
            path = url.path
            try:
                if path in ("/", "/index.html"):
                    return self._static("index.html")
                if path.startswith("/static/"):
                    return self._static(path[len("/static/") :])
                if path == "/api/config":
                    return self._json(app.config())
                m = re.fullmatch(r"/api/games/(\w+)/state", path)
                if m:
                    since = int((parse_qs(url.query).get("since") or ["0"])[0] or 0)
                    return self._json(app.state(app.get(m.group(1)), since))
                return self._error("Not found", 404)
            except KeyError:
                return self._error("对局不存在（服务器可能重启过）", 404)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._error(f"服务器错误：{e}", 500)

        def do_POST(self):
            path = urlparse(self.path).path
            try:
                body = self._body()
                if path == "/api/games":
                    return self._json(app.create_game(body))
                if path == "/api/check-key":
                    return self._json(app.check_key(body))
                m = re.fullmatch(r"/api/games/(\w+)/(action|hint|review|abort)", path)
                if m:
                    game = app.get(m.group(1))
                    op = m.group(2)
                    if op == "action":
                        game.submit(body)
                        return self._json({"ok": True})
                    if op == "hint":
                        return self._json(app.hint(game))
                    if op == "review":
                        return self._json(app.review(game))
                    game.cancel()
                    return self._json({"ok": True})
                return self._error("Not found", 404)
            except InvalidAction as e:
                return self._error(str(e), 400)
            except KeyError:
                return self._error("对局不存在（服务器可能重启过）", 404)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._error(f"服务器错误：{e}", 500)

    return Handler


def main(argv=None) -> None:
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(description="阿瓦隆单人练习：你 + DeepSeek AI 玩家")
    parser.add_argument("--host", default=os.environ.get("AVALON_HOST", "127.0.0.1"), help="监听地址（默认只允许本机访问）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AVALON_PORT", "8765")))
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    args = parser.parse_args(argv)

    app = App(
        api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
        model=os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL),
        base_url=os.environ.get("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL),
        offline_pace=float(os.environ.get("AVALON_OFFLINE_PACE", "0.9")),
    )
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    httpd.daemon_threads = True
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}/"
    print("=" * 50)
    print(" 阿瓦隆单人练习场已启动")
    print(f" 打开浏览器访问：{url}")
    print(f" DeepSeek API Key：{'已从环境变量/.env 读取' if app.api_key else '未配置（可在网页里填写，或使用离线AI）'}")
    print(" 按 Ctrl+C 退出")
    print("=" * 50)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n再见！")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

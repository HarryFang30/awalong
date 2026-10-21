"""极简 DeepSeek（OpenAI 兼容）客户端，只用标准库。"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Optional

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"


class LLMError(Exception):
    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.fatal = fatal  # 认证失败/余额不足等，重试没有意义


class DeepSeekClient:
    def __init__(
        self,
        api_key: str,
        *,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 90.0,
        max_retries: int = 2,
    ):
        self.api_key = api_key.strip()
        self.model = model.strip() or DEFAULT_MODEL
        self.base_url = (base_url.strip() or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.disabled_reason: Optional[str] = None
        self._lock = threading.Lock()
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0, "errors": 0}

    def usage_snapshot(self) -> dict:
        with self._lock:
            return dict(self.usage, model=self.model)

    def _request(self, method: str, path: str, body: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            if e.code == 401:
                raise LLMError("API Key 无效（401），请检查 DeepSeek API Key。", fatal=True)
            if e.code == 402:
                raise LLMError("DeepSeek 账户余额不足（402）。", fatal=True)
            if e.code in (400, 404, 422):
                raise LLMError(f"请求被拒绝（{e.code}）：{detail}", fatal=e.code == 404)
            raise LLMError(f"HTTP {e.code}：{detail}")
        except urllib.error.URLError as e:
            raise LLMError(f"网络错误：{e.reason}")
        except (TimeoutError, OSError) as e:
            raise LLMError(f"网络错误：{e}")
        except json.JSONDecodeError:
            raise LLMError("返回内容不是合法 JSON")

    def chat(
        self,
        messages: list[dict],
        *,
        json_mode: bool = False,
        temperature: float = 1.0,
        max_tokens: int = 1024,
    ) -> str:
        if self.disabled_reason:
            raise LLMError(self.disabled_reason, fatal=True)
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_mode and "reasoner" not in self.model:
            body["response_format"] = {"type": "json_object"}
        last: Optional[LLMError] = None
        for attempt in range(self.max_retries + 1):
            try:
                data = self._request("POST", "/chat/completions", body)
                content = data["choices"][0]["message"].get("content") or ""
                u = data.get("usage") or {}
                with self._lock:
                    self.usage["calls"] += 1
                    self.usage["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
                    self.usage["completion_tokens"] += int(u.get("completion_tokens") or 0)
                    self.usage["cache_hit_tokens"] += int(u.get("prompt_cache_hit_tokens") or 0)
                if not content.strip():
                    raise LLMError("模型返回了空内容")
                return content
            except LLMError as e:
                last = e
                with self._lock:
                    self.usage["errors"] += 1
                if e.fatal:
                    if "401" in str(e) or "402" in str(e):
                        self.disabled_reason = str(e)
                    raise
                if attempt < self.max_retries:
                    time.sleep(1.5 * (attempt + 1))
            except (KeyError, IndexError, TypeError):
                last = LLMError("返回格式异常")
        raise last or LLMError("未知错误")

    def check(self) -> str:
        """检查 Key 是否可用：列出模型（不消耗 token）。"""
        data = self._request("GET", "/models", timeout=20)
        models = [m.get("id") for m in data.get("data", []) if isinstance(m, dict)]
        return "、".join(m for m in models if m) or "OK"


def extract_json(text: str) -> dict:
    """从模型输出中提取 JSON 对象（兼容 ```json 代码块和前后多余文字）。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("输出中没有 JSON 对象")
        obj = json.loads(text[start : end + 1])
    if not isinstance(obj, dict):
        raise ValueError("输出不是 JSON 对象")
    return obj

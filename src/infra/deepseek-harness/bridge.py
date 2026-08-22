#!/usr/bin/env python3
"""Private stdio bridge for the official DeepSeek Harness Python SDK."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from typing import Any


_SECRET_ENV_NAMES = ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL")
_PROTOCOL_STRING_FIELDS = frozenset({
    "id",
    "requestId",
    "sessionId",
    "callId",
    "toolCallId",
    "kind",
    "method",
    "type",
    "code",
    "finishReason",
})
_BRIDGE_PROTOCOL_VERSION = 1


def _create_protocol_stdout() -> Any:
    stdout_fd = sys.stdout.fileno()
    protocol_fd = os.dup(stdout_fd)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), stdout_fd)
    return os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)


_PROTOCOL_STDOUT = _create_protocol_stdout()
_PROTOCOL_WRITE_LOCK = threading.Lock()


def _redact_text(text: str) -> str:
    for name in _SECRET_ENV_NAMES:
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return re.sub(
        r"(?i)(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )


def _redact_json(value: Any, field_name: str | None = None) -> Any:
    if isinstance(value, str):
        if field_name in _PROTOCOL_STRING_FIELDS:
            return value
        return _redact_text(value)
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, dict):
        return {
            _redact_text(key) if isinstance(key, str) else key: _redact_json(
                item,
                key if isinstance(key, str) else None,
            )
            for key, item in value.items()
        }
    return value


def _safe_text(value: object) -> str:
    return _redact_text(str(value))[:8192]


def _write(message: dict[str, Any]) -> None:
    safe_message = _redact_json(message)
    serialized = json.dumps(safe_message, ensure_ascii=False, separators=(",", ":"))
    with _PROTOCOL_WRITE_LOCK:
        _PROTOCOL_STDOUT.write(serialized + "\n")
        _PROTOCOL_STDOUT.flush()


def _error_code(error: BaseException) -> str:
    name = type(error).__name__
    if name == "SdkProtocolError":
        return "malformed-response"
    if name == "JsonRpcError":
        return "jsonrpc-error"
    if name == "TransportClosedError":
        return "transport-closed"
    if isinstance(error, FileNotFoundError):
        return "runtime-unavailable"
    if isinstance(error, TimeoutError):
        return "timeout"
    return "runtime-error"


def _error_message(error: BaseException) -> str:
    text = _safe_text(error)
    if text:
        return text
    return "DeepSeek Harness SDK operation failed"


def _start_harness(config: dict[str, Any]) -> Any:
    python_version = (sys.version_info.major, sys.version_info.minor)
    if python_version < (3, 10):
        raise RuntimeError("DeepSeek Harness requires Python 3.10 or newer")

    try:
        from deepseek_harness import DeepSeekHarness
    except Exception as error:
        raise RuntimeError(
            "DeepSeek Harness Python SDK is unavailable. Install deepseek-harness-sdk "
            "with its matching deepseek-harness-runtime-bin wheel."
        ) from error

    kwargs: dict[str, Any] = {
        "provider": config["provider"],
        "model": config["model"],
        "cwd": config["cwd"],
        "runtime_cwd": config["cwd"],
    }
    optional_fields = {
        "maxTokens": "max_tokens",
        "sessionRoot": "session_root",
        "cordis": "cordis",
    }
    for wire_name, sdk_name in optional_fields.items():
        value = config.get(wire_name)
        if value is not None:
            kwargs[sdk_name] = value
    timeout_ms = config.get("requestTimeoutMs")
    if timeout_ms is not None:
        kwargs["request_timeout_seconds"] = timeout_ms / 1000
    shutdown_timeout_ms = config.get("shutdownTimeoutMs")
    if shutdown_timeout_ms is not None:
        kwargs["shutdown_timeout_seconds"] = shutdown_timeout_ms / 1000

    harness = DeepSeekHarness(**kwargs)
    harness.start()
    return harness


def _run_request(harness: Any, request: dict[str, Any], request_id: str) -> None:
    def on_notification(notification: Any) -> None:
        _write(
            {
                "kind": "notification",
                "requestId": request_id,
                "notification": {
                    "method": notification.method,
                    "payload": notification.payload,
                },
            }
        )

    session = harness.start_session(request.get("sessionId"))
    _write(
        {
            "kind": "notification",
            "requestId": request_id,
            "notification": {
                "method": "session.started",
                "payload": {"sessionId": session.id},
            },
        }
    )
    result = session.run(request["prompt"], on_notification=on_notification)
    _write(
        {
            "kind": "result",
            "requestId": request_id,
            "result": {
                "sessionId": result.session_id,
                "finalResponse": result.final_response,
                "finishReason": result.finish_reason,
            },
        }
    )


def _handle_request(harness: Any, request: dict[str, Any]) -> Any:
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id:
        _write(
            {
                "kind": "error",
                "requestId": request_id,
                "error": {"code": "malformed-request", "message": "bridge request id is required"},
            }
        )
        return harness

    request_type = request.get("type")
    if request_type == "run":
        prompt = request.get("prompt")
        if not isinstance(prompt, str):
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": "malformed-request", "message": "bridge run prompt is required"},
                }
            )
            return harness
        try:
            _run_request(harness, request, request_id)
        except BaseException as error:
            code = _error_code(error)
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": code, "message": _error_message(error)},
                }
            )
            if code in {"transport-closed", "malformed-response"}:
                _close_harness(harness)
                return None
        return harness

    if request_type == "close":
        try:
            harness.close()
            _write({"kind": "closed", "requestId": request_id})
        except BaseException as error:
            _write(
                {
                    "kind": "error",
                    "requestId": request_id,
                    "error": {"code": "close-error", "message": _error_message(error)},
                }
            )
        return None

    _write(
        {
            "kind": "error",
            "requestId": request_id,
            "error": {"code": "malformed-request", "message": "unknown bridge request type"},
        }
    )
    return harness


def _close_harness(harness: Any) -> None:
    if harness is None:
        return
    try:
        harness.close()
    except BaseException:
        # Cleanup must not mask the original protocol or broken-pipe failure.
        pass


def main() -> int:
    harness: Any = None
    try:
        for raw_line in sys.stdin:
            if not raw_line.strip():
                continue
            try:
                request = json.loads(raw_line)
            except json.JSONDecodeError:
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "malformed-request", "message": "bridge received malformed JSON"},
                    }
                )
                return 2
            if not isinstance(request, dict):
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "malformed-request", "message": "bridge request must be an object"},
                    }
                )
                return 2

            if request.get("protocolVersion") != _BRIDGE_PROTOCOL_VERSION:
                _write(
                    {
                        "kind": "fatal",
                        "error": {
                            "code": "protocol-error",
                            "message": "unsupported DeepSeek Harness bridge protocol version",
                        },
                    }
                )
                return 2

            request_type = request.get("type")
            if request_type == "start":
                request_id = request.get("id")
                config = request.get("config")
                if not isinstance(request_id, str) or not isinstance(config, dict):
                    _write(
                        {
                            "kind": "fatal",
                            "error": {"code": "malformed-request", "message": "bridge start request is invalid"},
                        }
                    )
                    return 2
                try:
                    if harness is not None:
                        _close_harness(harness)
                        harness = None
                    harness = _start_harness(config)
                    _write({"kind": "ready", "requestId": request_id})
                except BaseException as error:
                    _write(
                        {
                            "kind": "fatal",
                            "requestId": request_id,
                            "error": {"code": _error_code(error), "message": _error_message(error)},
                        }
                    )
                    return 2
                continue

            if harness is None:
                _write(
                    {
                        "kind": "fatal",
                        "error": {"code": "not-started", "message": "bridge must be started before use"},
                    }
                )
                return 2

            harness = _handle_request(harness, request)
            if harness is None:
                return 0
        return 0
    finally:
        _close_harness(harness)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(0)

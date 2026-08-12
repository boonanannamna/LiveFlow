"""TikTok LIVE connector sidecar using the upstream TikTokLive GitHub project.

The desktop Rust process starts this file and consumes one JSON event per line.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import json
import sys
from http import HTTPStatus
from types import ModuleType, SimpleNamespace
from typing import Any

import httpx
from EulerApiSdk import AuthenticatedClient, Client
from EulerApiSdk.api import tik_tok_live as euler_tik_tok_live
from EulerApiSdk.errors import UnexpectedStatus
from EulerApiSdk.models import SignTikTokUrlResponse, WebcastRoomChatPayload, WebcastRoomChatRouteResponse
from EulerApiSdk.models.webcast_fetch_platform import WebcastFetchPlatform
from EulerApiSdk.models.sign_tik_tok_url_body import SignTikTokUrlBody
from EulerApiSdk.types import Response, UNSET, Unset


def _configure_utf8_streams() -> None:
    """Keep Thai text and emoji intact on every Windows launch path."""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            with suppress(Exception):
                reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


_configure_utf8_streams()


def _install_sign_webcast_url_shim() -> None:
    """Patch the generated SDK package with the route TikTokLive expects."""

    async def asyncio_detailed(
        *,
        client: AuthenticatedClient | Client,
        body: SignTikTokUrlBody,
    ) -> Response[SignTikTokUrlResponse]:
        response = await client.get_async_httpx_client().request(
            method="post",
            url="/tiktok/sign_url",
            json=body.to_dict(),
        )
        parsed = SignTikTokUrlResponse.from_dict(response.json()) if response.status_code == 200 else None
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=parsed,
        )

    def sync_detailed(*, client: AuthenticatedClient | Client, body: SignTikTokUrlBody) -> Response[SignTikTokUrlResponse]:
        response = client.get_httpx_client().request(
            method="post",
            url="/tiktok/sign_url",
            json=body.to_dict(),
        )
        parsed = SignTikTokUrlResponse.from_dict(response.json()) if response.status_code == 200 else None
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=parsed,
        )

    async def asyncio_wrapper(*, client: AuthenticatedClient | Client, body: SignTikTokUrlBody) -> SignTikTokUrlResponse | None:
        return (await asyncio_detailed(client=client, body=body)).parsed

    def sync_wrapper(*, client: AuthenticatedClient | Client, body: SignTikTokUrlBody) -> SignTikTokUrlResponse | None:
        return sync_detailed(client=client, body=body).parsed

    def fetch_get_kwargs(
        room_id: str,
        *,
        client_query: str = "ttlive-other",
        unique_id: str | Unset = UNSET,
        cursor: str | Unset = UNSET,
        user_agent: str | Unset = UNSET,
        client_enter: bool = True,
        country: Any = UNSET,
        platform: WebcastFetchPlatform | Unset = UNSET,
        session_id: str | Unset = UNSET,
        tt_target_idc: str | Unset = UNSET,
        x_oauth_token: str | Unset = UNSET,
        x_cookie_header: str | Unset = UNSET,
    ) -> dict[str, Any]:
        headers: dict[str, Any] = {}
        if x_oauth_token is not UNSET:
            headers["x-oauth-token"] = x_oauth_token
        if x_cookie_header is not UNSET:
            headers["x-cookie-header"] = x_cookie_header

        params: dict[str, Any] = {
            "client": client_query,
            "unique_id": unique_id,
            "cursor": cursor,
            "user_agent": user_agent,
            "client_enter": client_enter,
            "country": country.value if hasattr(country, "value") else country,
            "platform": platform.value if hasattr(platform, "value") else platform,
            "session_id": session_id,
            "tt_target_idc": tt_target_idc,
        }
        params = {k: v for k, v in params.items() if v is not UNSET and v is not None}
        return {
            "method": "get",
            "url": f"/webcast/rooms/{room_id}/connect",
            "params": params,
            "headers": headers,
        }

    async def fetch_async_detailed(
        *,
        client: AuthenticatedClient | Client,
        room_id: str,
        client_query: str,
        unique_id: str | Unset = UNSET,
        cursor: str | Unset = UNSET,
        user_agent: str,
        client_enter: bool = True,
        country: Any = UNSET,
        platform: WebcastFetchPlatform | Unset = UNSET,
        session_id: str | Unset = UNSET,
        tt_target_idc: str | Unset = UNSET,
        x_oauth_token: str | Unset = UNSET,
        x_cookie_header: str | Unset = UNSET,
    ) -> Response[bytes]:
        response = await client.get_async_httpx_client().request(**fetch_get_kwargs(
            room_id=room_id,
            client_query=client_query,
            unique_id=unique_id,
            cursor=cursor,
            user_agent=user_agent,
            client_enter=client_enter,
            country=country,
            platform=platform,
            session_id=session_id,
            tt_target_idc=tt_target_idc,
            x_oauth_token=x_oauth_token,
            x_cookie_header=x_cookie_header,
        ))
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=response.content,
        )

    def fetch_sync_detailed(
        *,
        client: AuthenticatedClient | Client,
        room_id: str,
        client_query: str,
        unique_id: str | Unset = UNSET,
        cursor: str | Unset = UNSET,
        user_agent: str,
        client_enter: bool = True,
        country: Any = UNSET,
        platform: WebcastFetchPlatform | Unset = UNSET,
        session_id: str | Unset = UNSET,
        tt_target_idc: str | Unset = UNSET,
        x_oauth_token: str | Unset = UNSET,
        x_cookie_header: str | Unset = UNSET,
    ) -> Response[bytes]:
        response = client.get_httpx_client().request(**fetch_get_kwargs(
            room_id=room_id,
            client_query=client_query,
            unique_id=unique_id,
            cursor=cursor,
            user_agent=user_agent,
            client_enter=client_enter,
            country=country,
            platform=platform,
            session_id=session_id,
            tt_target_idc=tt_target_idc,
            x_oauth_token=x_oauth_token,
            x_cookie_header=x_cookie_header,
        ))
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=response.content,
        )

    async def fetch_async(
        **kwargs: Any,
    ) -> bytes | None:
        return (await fetch_async_detailed(**kwargs)).parsed

    def fetch_sync(
        **kwargs: Any,
    ) -> bytes | None:
        return fetch_sync_detailed(**kwargs).parsed

    euler_tik_tok_live.sign_webcast_url = SimpleNamespace(
        asyncio_detailed=asyncio_detailed,
        asyncio=asyncio_wrapper,
        sync_detailed=sync_detailed,
        sync=sync_wrapper,
    )
    euler_tik_tok_live.fetch_webcast_url = SimpleNamespace(
        _get_kwargs=fetch_get_kwargs,
        asyncio_detailed=fetch_async_detailed,
        asyncio=fetch_async,
        sync_detailed=fetch_sync_detailed,
        sync=fetch_sync,
    )


def _install_send_room_chat_shim() -> None:
    """Patch the premium route TikTokLive uses for sending chat messages."""

    async def asyncio_detailed(
        *,
        client: AuthenticatedClient | Client,
        body: WebcastRoomChatPayload,
        x_cookie_header: str,
    ) -> Response[WebcastRoomChatRouteResponse]:
        response = await client.get_async_httpx_client().request(
            method="post",
            url="/chat-send",
            json=body.to_dict(),
            headers={"X-Cookie-Header": x_cookie_header},
        )
        parsed = WebcastRoomChatRouteResponse.from_dict(response.json()) if response.status_code == 200 else None
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=parsed,
        )

    def sync_detailed(
        *,
        client: AuthenticatedClient | Client,
        body: WebcastRoomChatPayload,
        x_cookie_header: str,
    ) -> Response[WebcastRoomChatRouteResponse]:
        response = client.get_httpx_client().request(
            method="post",
            url="/chat-send",
            json=body.to_dict(),
            headers={"X-Cookie-Header": x_cookie_header},
        )
        parsed = WebcastRoomChatRouteResponse.from_dict(response.json()) if response.status_code == 200 else None
        if response.status_code != 200 and client.raise_on_unexpected_status:
            raise UnexpectedStatus(response.status_code, response.content)
        return Response(
            status_code=HTTPStatus(response.status_code),
            content=response.content,
            headers=response.headers,
            parsed=parsed,
        )

    premium_module = ModuleType("EulerApiSdk.api.tik_tok_live_premium")
    premium_module.send_room_chat = SimpleNamespace(
        asyncio_detailed=asyncio_detailed,
        sync_detailed=sync_detailed,
    )
    sys.modules["EulerApiSdk.api.tik_tok_live_premium"] = premium_module


_install_sign_webcast_url_shim()
_install_send_room_chat_shim()

from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, ConnectEvent, DisconnectEvent, FollowEvent, GiftEvent, JoinEvent, LikeEvent, ShareEvent, WebsocketResponseEvent


def emit(event_type: str, **payload: Any) -> None:
    message = json.dumps({"type": event_type, **payload}, ensure_ascii=False)
    try:
        binary_stdout = getattr(sys.stdout, "buffer", None)
        if binary_stdout is not None:
            binary_stdout.write((message + "\n").encode("utf-8", errors="replace"))
            binary_stdout.flush()
            return
        if sys.stdout is not None:
            print(message, flush=True)
    except (OSError, ValueError, AttributeError):
        # The desktop parent may already have closed the pipe while shutting down.
        # Never let a reporting failure replace the actual TikTok connection error.
        return


def to_json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json_safe(item) for item in value]
    if hasattr(value, "model_dump"):
        with suppress(Exception):
            return to_json_safe(value.model_dump())
    if hasattr(value, "__dict__"):
        with suppress(Exception):
            return {key: to_json_safe(item) for key, item in vars(value).items() if not key.startswith("_")}
    return str(value)


def read_value(item: Any, *names: str) -> Any:
    if isinstance(item, dict):
        for name in names:
            if name in item:
                return item[name]
    for name in names:
        value = getattr(item, name, None)
        if value is not None:
            return value
    return None


def safe_str(value: Any) -> str:
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return ""


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def safe_bool(value: Any, default: bool = False) -> bool:
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value != 0
        text = str(value).strip().lower()
        if text in {"true", "1", "yes", "y"}:
            return True
        if text in {"false", "0", "no", "n"}:
            return False
        return default
    except Exception:
        return default


def safe_attr(obj: Any, attr_name: str, default: Any = "") -> Any:
    try:
        value = getattr(obj, attr_name, default)
        return default if value is None else value
    except Exception:
        return default


def pick_attr(obj: Any, names: list[str], default: Any = "") -> Any:
    if obj is None:
        return default
    for name in names:
        try:
            value = getattr(obj, name, None)
            if value is not None:
                return value
        except Exception:
            continue
    return default


def safe_nested(obj: Any, *attrs: str, default: Any = "") -> Any:
    try:
        current = obj
        for attr in attrs:
            current = getattr(current, attr)
            if current is None:
                return default
        return current
    except Exception:
        return default


def get_user_info(event: Any) -> dict[str, str]:
    user = safe_attr(event, "user", None)
    if user is None:
        user = safe_attr(event, "sender", None)
    if user is None:
        user = safe_attr(event, "user_info", None)
    if user is None:
        user = safe_attr(event, "userInfo", None)

    return {
        "nickname": safe_str(pick_attr(user, ["nickname", "nick_name", "display_name", "displayName", "name", "nickname_text"], "")),
        "uniqueId": safe_str(pick_attr(user, ["unique_id", "uniqueId", "user_id", "userId", "id", "sec_uid", "secUid"], "")),
        "userId": safe_str(pick_attr(user, ["id", "user_id", "userId", "sec_uid", "secUid"], "")),
        "profilePictureUrl": safe_str(pick_attr(user, ["profile_picture_url", "profilePictureUrl", "avatar_thumb", "avatarThumb", "avatar_url", "avatarUrl", "avatar", "profile_pic_url"], "")),
    }


def get_comment_info(event: Any) -> dict[str, str]:
    base_message = safe_attr(event, "base_message", None)
    comment_id = pick_attr(event, [
        "id",
        "event_id",
        "eventId",
        "msg_id",
        "msgId",
        "message_id",
        "messageId",
    ], "")
    if not comment_id:
        comment_id = pick_attr(event, ["m_log_id", "log_id"], "")
    if not comment_id:
        comment_id = safe_nested(base_message, "message_id", default="")
    if not comment_id:
        comment_id = safe_nested(base_message, "log_id", default="")
    return {
        "commentId": safe_str(comment_id).strip(),
        "commentLogId": safe_str(safe_nested(base_message, "log_id", default="")),
        "commentMessageId": safe_str(safe_nested(base_message, "message_id", default="")),
    }


def get_gift_info(event: Any) -> dict[str, Any]:
    gift = safe_attr(event, "gift", None)
    if gift is None:
        gift = safe_attr(event, "gift_info", None)
    if gift is None:
        gift = safe_attr(event, "giftInfo", None)

    repeat_count = safe_int(read_value(event, "repeat_count", "repeatCount", "count"), 1)
    gift_repeat_count = safe_int(read_value(gift, "repeat_count", "repeatCount", "count"), 1)
    combo_count = safe_int(read_value(event, "combo_count", "comboCount"), 0)
    gift_combo_count = safe_int(read_value(gift, "combo_count", "comboCount"), 0)

    if combo_count > repeat_count:
        repeat_count = combo_count
    if gift_repeat_count > repeat_count:
        repeat_count = gift_repeat_count
    if gift_combo_count > repeat_count:
        repeat_count = gift_combo_count
    if repeat_count <= 0:
        repeat_count = 1

    streaking = safe_bool(read_value(event, "streaking"), False)
    if not streaking:
        streaking = safe_bool(read_value(gift, "streaking", "is_streaking"), False)

    repeat_end = safe_bool(read_value(event, "repeat_end", "repeatEnd", "is_repeat_end", "isRepeatEnd", "streak_end", "streakEnd"), False)
    if not repeat_end:
        repeat_end = safe_bool(read_value(gift, "repeat_end", "repeatEnd", "is_repeat_end", "isRepeatEnd", "streak_end", "streakEnd"), False)

    streakable = safe_bool(read_value(gift, "streakable", "can_streak", "canStreak"), False)
    if not streakable:
        streakable = safe_bool(read_value(event, "streakable", "can_streak", "canStreak"), False)

    gift_name = safe_str(read_value(gift, "name", "gift_name", "giftName", "title"))
    gift_id = safe_str(read_value(gift, "id", "gift_id", "giftId", "gift_type", "giftType"))
    gift_image_url = safe_str(read_value(gift, "image_url", "imageUrl", "icon", "gift_image_url", "giftImageUrl", "image"))
    gift_description = safe_str(read_value(gift, "description", "desc", "gift_desc", "giftDescription"))
    diamond_count = safe_int(read_value(gift, "diamond_count", "diamondCount", "diamonds"), 0)
    if diamond_count <= 0:
        diamond_count = safe_int(read_value(event, "diamond_count", "diamondCount", "diamonds"), 0)

    return {
        "giftName": gift_name,
        "giftId": gift_id,
        "repeatCount": repeat_count,
        "comboCount": combo_count,
        "count": repeat_count,
        "streaking": streaking,
        "repeatEnd": repeat_end,
        "streakable": streakable,
        "diamondCount": diamond_count,
        "giftValue": read_value(event, "value"),
        "giftImageUrl": gift_image_url,
        "giftDescription": gift_description,
    }


def emit_gift_catalog(client: TikTokLiveClient) -> None:
    catalog = getattr(client, "gift_info", None) or {}
    items = catalog.values() if isinstance(catalog, dict) else catalog
    gifts = []
    for item in items or []:
        name = read_value(item, "name", "gift_name")
        if not name:
            continue
        gift_id = read_value(item, "id", "gift_id", "giftId")
        value = read_value(item, "coin_count", "coin_price", "diamond_count", "diamond_value")
        try:
            value = int(value) if value is not None else None
        except (TypeError, ValueError):
            value = None
        gifts.append({"name": str(name), "gift_id": safe_str(gift_id), "coin_value": value})
    emit("gift_catalog", gifts=gifts)


async def watch_for_stop(client: TikTokLiveClient) -> None:
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return
        if line.strip().lower() == "stop":
            emit("disconnected", reason="stopped")
            with suppress(Exception):
                await client.disconnect()
            return


async def heartbeat_loop(username: str) -> None:
    while True:
        await asyncio.sleep(15)
        emit("heartbeat", username=username)


async def run(username: str) -> None:
    normalized_username = username.lstrip("@")
    client = TikTokLiveClient(unique_id=normalized_username)
    connected_reported = False
    started_reported = False

    emit("worker_starting", username=normalized_username)

    @client.on(ConnectEvent)
    async def on_connect(event: ConnectEvent) -> None:
        nonlocal connected_reported
        nonlocal started_reported
        connected_reported = True
        started_reported = True
        room_id = safe_str(read_value(event, "room_id", "roomId") or read_value(client, "room_id", "roomId") or "")
        username_value = safe_str(read_value(event, "unique_id", "uniqueId", "username", "user_name", "userName") or normalized_username)
        emit("debug", stage="connected-event", message=f"เชื่อมต่อ TikTok LIVE สำเร็จ @{username_value}", detail=to_json_safe({"room_id": room_id, "username": username_value}))
        emit("connect", uniqueId=username_value, roomId=room_id, connected=True)
        emit("connected", username=username_value, room_id=room_id)

    @client.on(DisconnectEvent)
    async def on_disconnect(event: DisconnectEvent) -> None:
        reason = safe_str(read_value(event, "reason", "message", "detail") or "disconnected")
        emit("debug", stage="disconnect-event", message="TikTok LIVE ตัดการเชื่อมต่อ", detail=reason)
        emit("disconnect", uniqueId=normalized_username, connected=False, reason=reason)
        emit("disconnected", reason=reason)

    @client.on(WebsocketResponseEvent)
    async def on_websocket_response(event: WebsocketResponseEvent) -> None:
        event_name = type(event.event).__name__ if getattr(event, "event", None) is not None else "UnknownEvent"
        emit(
            "debug",
            stage="raw-event",
            message=f"ได้รับ event ใหม่: {event_name}",
            detail=to_json_safe({
                "event_name": event_name,
                "type": getattr(event, "type", None),
                "event": getattr(event, "event", None),
            }),
        )

    @client.on(CommentEvent)
    async def on_comment(event: CommentEvent) -> None:
        user = get_user_info(event)
        comment_meta = get_comment_info(event)
        comment_text = safe_str(read_value(event, "comment", "message", "text", "msg"))
        emit(
            "debug",
            stage="comment-received",
            message=f"รับ comment จาก @{user['uniqueId'] or user['nickname'] or normalized_username}",
            detail=to_json_safe({
                "comment": comment_text,
                "user": user,
                "comment_meta": comment_meta,
            }),
        )
        emit(
            "comment",
            username=user["uniqueId"] or user["nickname"] or normalized_username,
            nickname=user["nickname"],
            user_id=user["userId"],
            profile_picture_url=user["profilePictureUrl"],
            message=comment_text,
            comment=comment_text,
            comment_id=comment_meta["commentId"],
            comment_log_id=comment_meta["commentLogId"],
            comment_message_id=comment_meta["commentMessageId"],
            count=1,
        )

    @client.on(GiftEvent)
    async def on_gift(event: GiftEvent) -> None:
        user = get_user_info(event)
        gift = get_gift_info(event)
        emit(
            "debug",
            stage="gift-received",
            message=f"รับ gift จาก @{user['uniqueId'] or user['nickname'] or normalized_username}",
            detail=to_json_safe({
                "gift": gift,
                "user": user,
            }),
        )
        # TikTok sends cumulative updates while a streak is still running
        # (1, 2, 3, ...). Only the final event contains the authoritative
        # repeat_count; forwarding every update would over-count the gift.
        if gift["streakable"] and gift["streaking"]:
            emit(
                "debug",
                stage="gift-streak-progress",
                message=f"กำลังรอ combo จบ: {gift['giftName']} x{gift['repeatCount']}",
                detail=to_json_safe({
                    "gift_id": gift["giftId"],
                    "repeat_count": gift["repeatCount"],
                    "user_id": user["userId"],
                }),
            )
            return
        emit(
            "gift",
            username=user["uniqueId"] or user["nickname"] or normalized_username,
            nickname=user["nickname"],
            user_id=user["userId"],
            profile_picture_url=user["profilePictureUrl"],
            gift_name=gift["giftName"],
            gift_id=gift["giftId"],
            gift_type=gift["giftId"],
            repeat_count=gift["repeatCount"],
            combo_count=gift["comboCount"],
            count=gift["count"],
            streaking=gift["streaking"],
            repeat_end=gift["repeatEnd"],
            streakable=gift["streakable"],
            diamond_count=gift["diamondCount"],
            gift_value=gift["giftValue"],
            gift_image_url=gift["giftImageUrl"],
            gift_description=gift["giftDescription"],
        )

    @client.on(FollowEvent)
    async def on_follow(event: FollowEvent) -> None:
        user = get_user_info(event)
        emit("debug", stage="follow-received", message=f"follow จาก @{user['uniqueId'] or user['nickname'] or normalized_username}", detail=to_json_safe(user))
        emit("follow", username=user["uniqueId"] or user["nickname"] or normalized_username, nickname=user["nickname"], user_id=user["userId"], profile_picture_url=user["profilePictureUrl"])

    @client.on(LikeEvent)
    async def on_like(event: LikeEvent) -> None:
        user = get_user_info(event)
        like_count = safe_int(read_value(event, "count", "like_count", "likeCount"), 1)
        emit("debug", stage="like-received", message=f"like จาก @{user['uniqueId'] or user['nickname'] or normalized_username}", detail=to_json_safe({"like_count": like_count, "user": user}))
        emit("like", username=user["uniqueId"] or user["nickname"] or normalized_username, nickname=user["nickname"], user_id=user["userId"], profile_picture_url=user["profilePictureUrl"], like_count=like_count)

    @client.on(ShareEvent)
    async def on_share(event: ShareEvent) -> None:
        user = get_user_info(event)
        emit("debug", stage="share-received", message=f"share จาก @{user['uniqueId'] or user['nickname'] or normalized_username}", detail=to_json_safe(user))
        emit("share", username=user["uniqueId"] or user["nickname"] or normalized_username, nickname=user["nickname"], user_id=user["userId"], profile_picture_url=user["profilePictureUrl"])

    @client.on(JoinEvent)
    async def on_join(event: JoinEvent) -> None:
        user = get_user_info(event)
        emit("debug", stage="join-received", message=f"join จาก @{user['uniqueId'] or user['nickname'] or normalized_username}", detail=to_json_safe(user))
        emit("join", username=user["uniqueId"] or user["nickname"] or normalized_username, nickname=user["nickname"], user_id=user["userId"], profile_picture_url=user["profilePictureUrl"])

    emit("connecting", username=normalized_username)
    task = await client.start(fetch_gift_info=True)
    if not started_reported:
        emit("worker_started", username=normalized_username)
    if not connected_reported:
        room_id = safe_str(read_value(client, "room_id", "roomId") or "")
        emit(
            "debug",
            stage="waiting-connect-event",
            message="worker เริ่มทำงานแล้ว กำลังรอ TikTok ยืนยัน ConnectEvent",
            detail=to_json_safe({"username": normalized_username, "room_id": room_id}),
        )
    emit_gift_catalog(client)
    stop_task = asyncio.create_task(watch_for_stop(client))
    heartbeat_task = asyncio.create_task(heartbeat_loop(normalized_username))
    try:
        await task
    finally:
        stop_task.cancel()
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
          await stop_task
        with suppress(asyncio.CancelledError):
          await heartbeat_task
        emit("worker_stopped", username=normalized_username, reason="client task ended")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--username", required=True)
    args = parser.parse_args()
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            asyncio.run(run(args.username))
            return
        except KeyboardInterrupt:
            emit("disconnected", reason="stopped")
            return
        except Exception as error:  # keep the error machine-readable for Rust
            status_code = getattr(error, "status_code", None)
            is_websocket_400 = status_code == 400 or "HTTP 400" in str(error)
            if is_websocket_400 and attempt < max_attempts:
                emit(
                    "reconnecting",
                    username=args.username.lstrip("@"),
                    attempt=attempt,
                    max_attempts=max_attempts,
                    message=f"TikTok ปฏิเสธ WebSocket ชั่วคราว (HTTP 400) กำลังลองใหม่ {attempt}/{max_attempts}",
                )
                import time
                time.sleep(attempt * 2)
                continue

            if is_websocket_400:
                emit(
                    "error",
                    code="TIKTOK_WEBSOCKET_400",
                    stage="websocket-handshake",
                    message="TikTok ปฏิเสธการเชื่อมต่อ LIVE (HTTP 400) โปรดตรวจว่า username กำลัง LIVE แล้วกดเชื่อมต่อใหม่",
                )
            else:
                emit("error", code="CONNECTOR_ERROR", message=str(error))
            sys.exit(1)


if __name__ == "__main__":
    main()

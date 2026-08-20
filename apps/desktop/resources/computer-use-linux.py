#!/usr/bin/env python3
"""Small AT-SPI provider for Orchestra Computer Use.

The Electron process owns authentication and sends one JSON operation on
stdin. This provider never persists payloads or clipboard contents.
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

import gi

gi.require_version("Atspi", "2.0")
try:
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
except (ImportError, ValueError):
    Gdk = None
from gi.repository import Atspi

MAX_NODES = 900
MAX_DEPTH = 48
BLOCKED_APPS = ("1password", "bitwarden", "dashlane", "lastpass", "proton pass")


def attempt(fn, fallback=None):
    try:
        value = fn()
        return fallback if value is None else value
    except Exception:
        return fallback


def children(node):
    for index in range(int(attempt(node.get_child_count, 0) or 0)):
        child = attempt(lambda index=index: node.get_child_at_index(index))
        if child is not None:
            yield index, child


def name(node):
    return str(attempt(node.get_name, "") or "")


def role(node):
    return str(attempt(node.get_role_name, "") or "")


def pid(node):
    return int(attempt(node.get_process_id, 0) or 0)


def has_state(node, state):
    state_set = attempt(node.get_state_set)
    return bool(state_set and attempt(lambda: state_set.contains(state), False))


def rect(node):
    component = attempt(node.get_component_iface)
    bounds = attempt(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.SCREEN)) if component else None
    if not bounds or bounds.width <= 0 or bounds.height <= 0:
        return None
    return {"x": float(bounds.x), "y": float(bounds.y), "width": float(bounds.width), "height": float(bounds.height)}


def desktop_apps():
    root = Atspi.get_desktop(0)
    for _, app in children(root):
        if name(app):
            yield app


def app_windows(app):
    result = []
    for index, child in children(app):
        if rect(child) or role(child).lower() in {"frame", "window", "dialog", "alert"}:
            result.append((index, child))
    return result


def find_app(query):
    needle = str(query or "").strip().lower()
    for app in desktop_apps():
        matches_pid = needle.startswith("pid:") and needle[4:].isdigit() and pid(app) == int(needle[4:])
        haystacks = [name(app).lower()] + [name(window).lower() for _, window in app_windows(app)]
        if matches_pid or any(value == needle or needle in value for value in haystacks):
            if any(fragment in value for fragment in BLOCKED_APPS for value in haystacks):
                raise RuntimeError("app_blocked: password managers cannot be controlled")
            return app
    raise RuntimeError('app_not_found: ' + str(query))


def choose_window(app, requested=None):
    windows = app_windows(app)
    if not windows:
        raise RuntimeError("window_not_found: no visible top-level window")
    if requested is not None:
        for index, window in windows:
            if index == int(requested):
                return index, window
        raise RuntimeError("window_not_found: index is stale")
    for item in windows:
        if has_state(item[1], Atspi.StateType.ACTIVE):
            return item
    return windows[0]


def clean_text(value, limit=320):
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())[:limit]


def value_of(node):
    if "password" in role(node).lower():
        return "[protected]"
    text_iface = attempt(node.get_text_iface)
    if text_iface:
        count = int(attempt(lambda: Atspi.Text.get_character_count(text_iface), 0) or 0)
        return clean_text(attempt(lambda: Atspi.Text.get_text(text_iface, 0, min(count, 320)), ""))
    value_iface = attempt(node.get_value_iface)
    if value_iface:
        return clean_text(attempt(lambda: Atspi.Value.get_current_value(value_iface), ""))
    return ""


def action_names(node):
    result = []
    for index in range(int(attempt(node.get_n_actions, 0) or 0)):
        label = clean_text(attempt(lambda index=index: node.get_action_name(index), ""), 80)
        if label and label not in result:
            result.append(label)
    return result


def snapshot(query, window_index=None):
    app = find_app(query)
    selected_index, window = choose_window(app, window_index)
    window_rect = rect(window)
    records = []
    lines = []
    stack = [(window, [selected_index], 0)]
    while stack and len(records) < MAX_NODES:
        node, path, depth = stack.pop()
        node_rect = rect(node)
        relative = None
        if node_rect and window_rect:
            relative = {**node_rect, "x": node_rect["x"] - window_rect["x"], "y": node_rect["y"] - window_rect["y"]}
        record = {
            "index": len(records), "path": path, "role": role(node), "name": clean_text(name(node)),
            "value": value_of(node), "frame": relative, "actions": action_names(node),
            "focused": has_state(node, Atspi.StateType.FOCUSED), "enabled": has_state(node, Atspi.StateType.ENABLED)
        }
        records.append(record)
        summary = f'{record["index"]} {record["role"]}'
        if record["name"]:
            summary += f' "{record["name"]}"'
        if record["value"] and record["value"] != record["name"]:
            summary += f' value="{record["value"]}"'
        if record["actions"]:
            summary += " actions=" + ",".join(record["actions"])
        lines.append("  " * depth + summary)
        if depth < MAX_DEPTH:
            child_items = list(children(node))
            for child_index, child in reversed(child_items):
                stack.append((child, path + [child_index], depth + 1))
    return {
        "snapshotId": str(uuid.uuid4()),
        "app": {"name": name(app), "pid": pid(app)},
        "window": {"title": name(window), "index": selected_index, "bounds": window_rect},
        "coordinateSpace": "window", "treeText": "\n".join(lines), "elements": records,
        "elementCount": len(records), "truncated": len(records) >= MAX_NODES
    }, app, window


def element_at(snapshot_value, index):
    value = int(index)
    for element in snapshot_value["elements"]:
        if element["index"] == value:
            return element
    raise RuntimeError("element_not_found: refresh app state")


def node_at_path(app, path):
    node = app
    for index in path:
        node = dict(children(node)).get(int(index))
        if node is None:
            raise RuntimeError("element_not_found: UI changed; refresh app state")
    return node


def focus_window(app, window):
    component = attempt(window.get_component_iface)
    if component and attempt(lambda: Atspi.Component.grab_focus(component), False):
        return
    if shutil.which("xdotool") and pid(app):
        subprocess.run(["xdotool", "search", "--pid", str(pid(app)), "windowactivate", "--sync"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def point_for(window, element=None, x=None, y=None):
    bounds = rect(window) or {"x": 0, "y": 0}
    if element and element.get("frame"):
        frame = element["frame"]
        return bounds["x"] + frame["x"] + frame["width"] / 2, bounds["y"] + frame["y"] + frame["height"] / 2
    if x is None or y is None:
        raise RuntimeError("invalid_argument: elementIndex or x/y required")
    return bounds["x"] + float(x), bounds["y"] + float(y)


def press_key(raw):
    aliases = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "backspace": "BackSpace", "delete": "Delete", "left": "Left", "right": "Right", "up": "Up", "down": "Down", "tab": "Tab", "space": "space"}
    key = aliases.get(str(raw).lower(), str(raw))
    if len(key) == 1:
        Atspi.generate_keyboard_event(0, key, Atspi.KeySynthType.STRING)
    elif Gdk:
        Atspi.generate_keyboard_event(Gdk.keyval_from_name(key), None, Atspi.KeySynthType.PRESSRELEASE)
    else:
        raise RuntimeError("unsupported_capability: GDK is required for this key")


def capabilities():
    return {
        "platform": "linux", "provider": "orchestra-computer-use-atspi", "protocolVersion": 1,
        "supports": {
            "apps": {"list": True, "pids": True}, "windows": {"list": True, "targetByIndex": True},
            "observation": {"accessibilityTree": True, "elementFrames": True, "screenshot": False, "ocr": False},
            "actions": {"click": True, "typeText": True, "pressKey": True, "scroll": True, "drag": True, "setValue": True}
        }
    }


def run(operation):
    tool = operation.get("tool")
    if tool == "capabilities":
        return {"ok": True, "capabilities": capabilities()}
    if tool == "list_apps":
        apps = [{"name": name(app), "pid": pid(app)} for app in desktop_apps() if app_windows(app)]
        return {"ok": True, "apps": sorted(apps, key=lambda item: item["name"].lower())}
    snap, app, window = snapshot(operation.get("app", ""), operation.get("windowIndex"))
    if tool == "get_app_state":
        return {"ok": True, "snapshot": snap}
    selected = element_at(snap, operation["elementIndex"]) if operation.get("elementIndex") is not None else None
    node = node_at_path(app, selected["path"]) if selected else None
    focus_window(app, window)
    if tool == "click":
        performed = False
        if node:
            for action_index, label in enumerate(action_names(node)):
                if label.lower() in {"click", "press", "activate", "invoke", "select", "toggle", "open"}:
                    performed = bool(attempt(lambda action_index=action_index: node.do_action(action_index), False))
                    if performed:
                        break
        if not performed:
            x, y = point_for(window, selected, operation.get("x"), operation.get("y"))
            Atspi.generate_mouse_event(round(x), round(y), "b1c")
    elif tool == "type_text":
        Atspi.generate_keyboard_event(0, str(operation.get("text", "")), Atspi.KeySynthType.STRING)
    elif tool == "press_key":
        press_key(operation.get("key", ""))
    elif tool == "set_value":
        editable = attempt(node.get_editable_text_iface) if node else None
        if not editable or not attempt(lambda: Atspi.EditableText.set_text_contents(editable, str(operation.get("value", ""))), False):
            raise RuntimeError("value_not_settable: use click and type-text")
    elif tool == "scroll":
        x, y = point_for(window, selected, operation.get("x"), operation.get("y"))
        direction = str(operation.get("direction", "down")).lower()
        event = {"up": "wu", "down": "wd", "left": "wl", "right": "wr"}.get(direction)
        if not event:
            raise RuntimeError("invalid_argument: direction must be up/down/left/right")
        for _ in range(max(1, min(20, int(operation.get("amount", 3))))):
            Atspi.generate_mouse_event(round(x), round(y), event)
    elif tool == "drag":
        start_x, start_y = point_for(window, None, operation.get("fromX"), operation.get("fromY"))
        end_x, end_y = point_for(window, None, operation.get("toX"), operation.get("toY"))
        Atspi.generate_mouse_event(round(start_x), round(start_y), "b1p")
        for step in range(1, 13):
            Atspi.generate_mouse_event(round(start_x + (end_x - start_x) * step / 12), round(start_y + (end_y - start_y) * step / 12), "abs")
            time.sleep(.015)
        Atspi.generate_mouse_event(round(end_x), round(end_y), "b1r")
    else:
        raise RuntimeError("invalid_argument: unknown computer-use operation")
    refreshed, _, _ = snapshot(operation.get("app", ""), operation.get("windowIndex"))
    return {"ok": True, "action": {"type": tool}, "snapshot": refreshed}


if __name__ == "__main__":
    try:
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            raise RuntimeError("accessibility_error: active desktop session required")
        print(json.dumps(run(json.load(sys.stdin)), separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))

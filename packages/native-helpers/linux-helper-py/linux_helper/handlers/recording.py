"""System audio muting via PipeWire/PulseAudio (pactl)."""

import subprocess

_was_muted_before_recording = False


def _get_sink_mute_state() -> bool:
    try:
        result = subprocess.run(
            ["pactl", "get-sink-mute", "@DEFAULT_SINK@"],
            capture_output=True, text=True, timeout=5,
        )
        return "yes" in result.stdout
    except (subprocess.SubprocessError, OSError):
        return False


def handle_start_recording(params: dict) -> dict:
    global _was_muted_before_recording
    mute_system_audio = params.get("muteSystemAudio", False)

    try:
        if mute_system_audio:
            _was_muted_before_recording = _get_sink_mute_state()
            if not _was_muted_before_recording:
                subprocess.run(
                    ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "1"],
                    check=True, timeout=5,
                )
        return {"success": True}
    except Exception as e:
        return {"success": False, "message": str(e)}


def handle_stop_recording(params: dict) -> dict:
    global _was_muted_before_recording
    was_muted = params.get("wasMuted", False)

    try:
        if was_muted and not _was_muted_before_recording:
            subprocess.run(
                ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "0"],
                check=True, timeout=5,
            )
        return {"success": True}
    except Exception as e:
        return {"success": False, "message": str(e)}

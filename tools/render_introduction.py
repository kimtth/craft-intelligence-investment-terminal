"""Render verified Electron PNG captures, not fabricated UI or streamed Python frames.

Dependencies: installed imageio_ffmpeg, its FFmpeg with libx264 + drawtext, Malgun Gothic.
No downloads, Pillow, SDK, audio generation, or app changes. All subprocesses are FFmpeg.
Each captured still is held for the storyboard duration, explicitly labelled in Korean.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[1]
VIDEO = ROOT / "video"
FPS = 30
WIDTH, HEIGHT = 1920, 1080
TOTAL_FRAMES = 3600


class PipelineError(Exception):
    """Messages are controlled strings, never raw FFmpeg output or user identities."""


def require(condition: object, message: str) -> None:
    if not condition:
        raise PipelineError(message)


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(file: Path, value: dict) -> None:
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def image_path(relative: str) -> Path:
    require(isinstance(relative, str), "Invalid image path.")
    candidate = (VIDEO / relative).resolve()
    require(candidate.is_relative_to((VIDEO / "assets").resolve()), "Image must be under video/assets.")
    require(candidate.suffix.lower() == ".png" and candidate.is_file(), "Capture PNG missing.")
    return candidate


def png_size(file: Path) -> tuple[int, int]:
    with file.open("rb") as stream:
        header = stream.read(24)
    require(header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR", "Invalid PNG header.")
    return struct.unpack(">II", header[16:24])


def ffmpeg_run(executable: str, args: list[str], cwd: Path, stage: str) -> subprocess.CompletedProcess:
    result = subprocess.run(
        [executable, "-hide_banner", "-nostdin", "-y", *args],
        cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        encoding="utf-8", errors="replace", check=False,
    )
    # Raw stderr may contain absolute paths; never persist or print it.
    require(result.returncode == 0, f"FFmpeg failed at {stage}; no delivery certified.")
    return result


def frame_count(seconds: object) -> int:
    require(isinstance(seconds, (int, float)) and not isinstance(seconds, bool), "Invalid duration type.")
    value = float(seconds) * FPS
    require(math.isfinite(value) and value > 0 and abs(value - round(value)) < 1e-7, "Duration must be a positive whole number of frames.")
    return round(value)


def validate(plan: dict, manifest: dict) -> list[dict]:
    require(plan.get("version") == manifest.get("version") == 1, "Unsupported manifest version.")
    require(manifest.get("status") == "captured", "Capture is not complete.")
    require(manifest.get("plan_sha256") == digest(VIDEO / "scene-plan.json"), "Storyboard changed; recapture first.")
    require((plan.get("width"), plan.get("height"), plan.get("fps"), plan.get("duration_seconds"))
            == (WIDTH, HEIGHT, FPS, 120), "Expected 1920x1080, 30fps, 120 seconds.")
    require(plan.get("capture_content_size") == [1500, 1000] and plan.get("audio") is False, "Unexpected capture contract.")
    require(manifest.get("security") == {"sandbox": True, "contextIsolation": True,
            "nodeIntegration": False, "contentSize": [1500, 1000]}, "Capture security contract changed.")
    require(manifest.get("safety") == {"sdk_calls": 0, "connection_checks": 0,
            "external_ui_requests_allowed": 0, "orders": 0, "market_fetches": 0,
            "clipboard_writes": 0, "agent_submissions": 0}, "Capture safety checks missing.")
    require(manifest.get("audit", {}).get("blocked") == 0 and manifest.get("page_errors") == 0,
            "Capture has blocked requests or renderer errors.")
    require(manifest.get("audit", {}).get("market_show", 0) >= 2, "Saved archive verification missing.")
    require(manifest.get("archive", {}).get("provider") == "Yahoo Finance", "Real Yahoo archive required.")
    require(bool(manifest.get("source_sha256")), "Source hashes missing.")
    # Captured source hashes are provenance, not a demand to overwrite newer app code.
    scenes, shots = plan.get("scenes", []), manifest.get("shots", [])
    require(len(scenes) == 9 and len(shots) == 18, "Expected nine scenes and eighteen screenshots.")
    require(len({scene["id"] for scene in scenes}) == 9, "Duplicate scene IDs.")
    expected = [(scene, index) for scene in scenes for index in range(2)]
    output = []
    total = 0
    for shot, (scene, index) in zip(shots, expected, strict=True):
        require(re.fullmatch(r"[a-z]+", scene["id"]), "Unsafe scene ID.")
        require(shot.get("scene_id") == scene["id"] and shot.get("shot_index") == index, "Shot order mismatch.")
        require(len(scene["shot_seconds"]) == 2, "Expected two holds per scene.")
        require(sum(scene["shot_seconds"]) == scene["seconds"], "Scene duration mismatch.")
        require(shot.get("seconds") == scene["shot_seconds"][index], "Hold duration mismatch.")
        require(len(scene.get("subtitles", [])) == 2, "Expected two Korean caption lines.")
        for text in [scene["title"], *scene["subtitles"], plan["hold_label"]]:
            require(isinstance(text, str) and 0 < len(text) <= 90 and "\n" not in text,
                    "Caption must be one short line.")
        frames = frame_count(shot["seconds"])
        source = image_path(shot["file"])
        require(digest(source) == shot.get("sha256"), "Capture image hash mismatch.")
        require(png_size(source) == (1500, 1000), "Expected a 1500x1000 actual content screenshot.")
        crop = shot.get("crop")
        if crop:
            require(shot.get("presentation") == "edited_hold_detail_crop", "Crop must be labelled.")
            require(set(crop) == {"x", "y", "width", "height"}, "Invalid crop keys.")
            require(all(type(value) is int for value in crop.values()), "Crop must have integer bounds.")
            require(crop["x"] >= 0 and crop["y"] >= 0 and crop["width"] > 0 and crop["height"] > 0
                    and crop["x"] + crop["width"] <= 1500 and crop["y"] + crop["height"] <= 1000,
                    "Crop extends outside the real screenshot.")
        else:
            require(shot.get("presentation") == "edited_hold_full_content", "Hold must be labelled.")
        output.append({**shot, "scene": scene, "source": source, "frames": frames, "start_frame": total})
        total += frames
    require(total == TOTAL_FRAMES, "Timeline must be exactly 3600 frames / 120 seconds.")
    return output


def text_filter(filename: str, size: int, x: str, y: int, color: str = "white") -> str:
    # Font copied to a safe basename in the FFmpeg cwd. No drive colon/backslash reaches
    # filter parsing (C:/Windows/Fonts/malgun.ttf otherwise needs multiple escape layers).
    # expansion=none also prevents percent expressions in textfiles from executing.
    return (f"drawtext=fontfile=caption-font.ttf:textfile={filename}:expansion=none:"
            f"fontsize={size}:fontcolor={color}:x={x}:y={y}:fix_bounds=0")


def text_width(executable: str, work: Path, textfile: str, size: int) -> int:
    # Let the installed font renderer measure the actual Korean text; never guess by
    # character count or silently shrink long subtitles to an unreadable size.
    result = ffmpeg_run(executable, ["-loglevel", "info", "-f", "lavfi", "-i",
        "color=c=black:s=1920x1080:r=1", "-vf", text_filter(textfile, size, "print(text_w)", 0),
        "-frames:v", "1", "-f", "null", "-"], work, "caption measurement")
    # The expression evaluator's print() is stable across drawtext debug-log formats.
    widths = re.findall(r"^\s*(\d+(?:\.\d+)?)\s*$", result.stderr, flags=re.MULTILINE)
    require(bool(widths), "Cannot measure caption width with this FFmpeg drawtext build.")
    width = math.ceil(max(map(float, widths)))
    require(width > 0, "Font produced an empty caption.")
    return width


def render(font: Path) -> None:
    VIDEO.mkdir(parents=True, exist_ok=True)
    lockfile = VIDEO / ".introduction.lock"
    try:
        lock = lockfile.open("x", encoding="utf-8")
    except FileExistsError as error:
        raise PipelineError("Capture/render lock exists. Do not run concurrently; remove only after confirming no pipeline is running.") from error
    stage = "preflight"
    work = VIDEO / "assets" / f"render-{uuid.uuid4()}"
    try:
        # Remove old certified outputs BEFORE parsing input/importing optional dependencies.
        for name in ["verification.json", "introduction.mp4", "contact-sheet.png"]:
            (VIDEO / name).unlink(missing_ok=True)
        write_json(VIDEO / "render-status.json", {"status": "running", "stage": stage})
        plan_path = VIDEO / "scene-plan.json"
        manifest_path = VIDEO / "capture-manifest.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        inputs = {"plan_sha256": digest(plan_path), "capture_manifest_sha256": digest(manifest_path)}
        shots = validate(plan, manifest)
        require(font.is_file(), "Malgun font missing. Supply --font with an installed Korean TTF font.")
        import imageio_ffmpeg  # Installed dependency; never install or download anything.

        executable = imageio_ffmpeg.get_ffmpeg_exe()
        require(Path(executable).is_file() or shutil.which(executable), "Installed FFmpeg unavailable.")
        work.mkdir(parents=True)
        shutil.copyfile(font, work / "caption-font.ttf")
        version = ffmpeg_run(executable, ["-version"], work, "version").stdout.splitlines()[0]
        filters = ffmpeg_run(executable, ["-filters"], work, "filter preflight").stdout
        encoders = ffmpeg_run(executable, ["-encoders"], work, "encoder preflight").stdout
        require(all(re.search(rf"\b{name}\b", filters) for name in ["drawtext", "scale", "pad", "tile"]),
                "Installed FFmpeg needs drawtext, scale, pad and tile. No fallback UI or automatic download is used.")
        require(re.search(r"\blibx264\b", encoders), "Installed FFmpeg needs libx264.")
        measurements: dict[tuple[str, int], int] = {}

        def caption(filename: str, text: str, size: int, maximum: int) -> None:
            (work / filename).write_text(text, encoding="utf-8")
            key = (text, size)
            if key not in measurements:
                measurements[key] = text_width(executable, work, filename, size)
            require(measurements[key] <= maximum,
                    "Caption would clip. Shorten the storyboard line and recapture; font sizes are not silently reduced.")

        stage = "encode_holds"
        segments = []
        for number, shot in enumerate(shots):
            scene = shot["scene"]
            prefix = f"shot-{number:02d}"
            shutil.copyfile(shot["source"], work / f"{prefix}.png")
            require(digest(work / f"{prefix}.png") == shot["sha256"], "Source changed while copying.")
            caption(f"{prefix}-title.txt", scene["title"], 44, 1800)
            label = plan["hold_label"] + (" · Detail crop" if shot.get("crop") else " · Full view")
            caption(f"{prefix}-hold.txt", label, 28, 1800)
            for index, line in enumerate(scene["subtitles"]):
                caption(f"{prefix}-sub{index}.txt", line, 42, 1800)
            crop = shot.get("crop")
            vf = []
            if crop:
                vf.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
            # Never stretch the screenshot; center within an 1800x780 content area.
            # Top band 0..119, app 120..899, subtitles 900..1079. No caption covers UI.
            vf += ["scale=1800:780:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
                   "pad=1920:1080:(ow-iw)/2:120+(780-ih)/2:color=0x101b2c", "setsar=1",
                   text_filter(f"{prefix}-title.txt", 44, "60", 15),
                   text_filter(f"{prefix}-hold.txt", 28, "60", 77, "0xafd0f7"),
                   text_filter(f"{prefix}-sub0.txt", 42, "(w-text_w)/2", 930),
                   text_filter(f"{prefix}-sub1.txt", 42, "(w-text_w)/2", 993), "format=yuv420p"]
            segment = f"{prefix}.mp4"
            ffmpeg_run(executable, ["-loglevel", "error", "-loop", "1", "-framerate", str(FPS),
                "-i", f"{prefix}.png", "-vf", ",".join(vf), "-frames:v", str(shot["frames"]),
                "-an", "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage",
                "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), "-threads", "2",
                "-video_track_timescale", "15360", "-map_metadata", "-1", segment], work, stage)
            segments.append(segment)
            print(f"Encoded hold {number + 1}/18.", flush=True)

        stage = "concat"
        (work / "segments.txt").write_text("".join(f"file '{file}'\n" for file in segments), encoding="utf-8")
        # Equal-size, equal-codec, equal-timebase segments: lossless concat, no second generation.
        ffmpeg_run(executable, ["-loglevel", "error", "-f", "concat", "-safe", "1", "-i", "segments.txt",
            "-map", "0:v:0", "-an", "-c:v", "copy", "-map_metadata", "-1",
            "-movflags", "+faststart", "introduction.mp4"], work, stage)
        delivery = work / "introduction.mp4"
        stage = "full_decode"
        decoded = ffmpeg_run(executable, ["-loglevel", "info", "-xerror", "-err_detect", "explode",
            "-i", "introduction.mp4", "-map", "0:v:0", "-an", "-progress", "pipe:1", "-nostats",
            "-f", "null", "-"], work, stage)
        progress = dict(re.findall(r"^([a-z_]+)=(.*)$", decoded.stdout, flags=re.MULTILINE))
        require(progress.get("progress", "").strip() == "end", "Full decode did not finish.")
        require(int(progress.get("frame", "0")) == TOTAL_FRAMES, "Full decode frame count is not 3600.")
        reader = imageio_ffmpeg.read_frames(str(delivery), pix_fmt="rgb24")
        try:
            metadata = next(reader)  # Metadata only; never iterate 3600 raw frames in Python.
        finally:
            reader.close()
        require(metadata.get("codec") == "h264", "Output codec is not H.264.")
        require(tuple(metadata.get("size", ())) == (WIDTH, HEIGHT), "Output dimensions are wrong.")
        require(abs(metadata.get("fps", 0) - FPS) < 0.001, "Output frame rate is wrong.")
        require(abs(metadata.get("duration", 0) - 120) <= 1 / FPS, "Stream duration is not 120 seconds.")
        require("yuv420p" in metadata.get("pix_fmt", ""), "Output pixel format is not yuv420p.")
        require(not re.search(r"Stream #0:\d+.*Audio:", decoded.stderr), "Unexpected audio stream.")
        stage = "contact_sheet"
        # Pick the middle of each scene's second (detail/action-result) hold. -ss AFTER -i
        # means accurate output seek, not approximate keyframe/input seek.
        sample_times = []
        for index, shot in enumerate(shots[1::2]):
            second = (shot["start_frame"] + shot["frames"] // 2) / FPS
            sample_times.append(second)
            ffmpeg_run(executable, ["-loglevel", "error", "-i", "introduction.mp4", "-ss", f"{second:.6f}",
                "-frames:v", "1", "-vf", "scale=640:360", f"contact-{index:02d}.png"], work, stage)
        ffmpeg_run(executable, ["-loglevel", "error", "-framerate", "1", "-start_number", "0",
            "-i", "contact-%02d.png", "-vf", "tile=3x3:nb_frames=9", "-frames:v", "1",
            "contact-sheet.png"], work, stage)
        require(png_size(work / "contact-sheet.png") == (1920, 1080), "Contact sheet size mismatch.")
        require(digest(plan_path) == inputs["plan_sha256"] and digest(manifest_path) == inputs["capture_manifest_sha256"],
                "Inputs changed during render.")
        for shot in shots:
            require(digest(shot["source"]) == shot["sha256"], "Capture changed during render.")
        report = {"status": "passed", "encoding_verified": True, "visual_review": "pending_human_review",
            "sha256": digest(delivery), "bytes": delivery.stat().st_size,
            "duration_seconds": metadata["duration"], "width": WIDTH, "height": HEIGHT,
            "fps": FPS, "decoded_frames": TOTAL_FRAMES, "codec": "h264", "pixel_format": "yuv420p",
            "audio": False, "full_decode": {"exit_code": decoded.returncode, "progress": "end"},
            "ffmpeg_version": version, "font_sha256": digest(work / "caption-font.ttf"),
            "renderer_sha256": digest(Path(__file__)), **inputs,
            "capture_run_id": manifest["run_id"], "contact_sheet_sha256": digest(work / "contact-sheet.png"),
            "contact_sheet_seconds": sample_times,
            "presentation": {"real_time_recording": False, "actual_electron_gui": True,
                "edited_still_holds": 18, "scenes": 9, "every_hold_labelled": True,
                "os_chrome_included": False, "subtitles_font_px": 42, "detail_crops_labelled": True},
            "safety": manifest["safety"],
            "limitations": ["No narration or AI answer; question draft and prompt selection only.",
                "Encoding checks do not replace a human Korean text/readability/privacy review.",
                "Source screenshots are real captures; holds, cuts, crops and captions are edited.",
                "External UI requests blocked; no process-wide network firewall claim.",
                "Data redistribution rights require separate review."]}
        stage = "publish"
        delivery.replace(VIDEO / "introduction.mp4")
        (work / "contact-sheet.png").replace(VIDEO / "contact-sheet.png")
        write_json(VIDEO / "verification.json", report)  # Commit marker published LAST.
        write_json(VIDEO / "render-status.json", {"status": "passed", "sha256": report["sha256"]})
        print("Published video/introduction.mp4: 120 seconds, 1920x1080 H.264, 3600 decoded frames. Visual review pending.")
    except BaseException:
        for name in ["verification.json", "introduction.mp4", "contact-sheet.png"]:
            (VIDEO / name).unlink(missing_ok=True)
        write_json(VIDEO / "render-status.json", {"status": "failed", "stage": stage})
        raise
    finally:
        # Retain only source captures and delivered artifacts, not giant intermediate encodes.
        try:
            if work.exists():
                shutil.rmtree(work)
        finally:
            lock.close()
            lockfile.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/malgun.ttf"))
    args = parser.parse_args()
    try:
        render(args.font.resolve())
    except PipelineError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        # Controlled status retains the failed stage; raw tracebacks can expose local identity paths.
        print("Render failed; no delivery certified. Check render-status and installed inputs/dependencies.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
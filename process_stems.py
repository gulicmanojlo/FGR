import os
import subprocess
import json
import shutil
import re
import stat
import sys
import time
from datetime import datetime, timezone

PLAYLISTS_DIR = "playlists"
LOG_FILE = "samples/stems_log.txt"
DEMUCS_MODEL = "htdemucs_6s"
# Four equivariant stabilization passes are deliberately the default. Stem
# separation is the core product feature, so the extra processing time is a
# better trade than letting a faster single/two-pass result leak vocals or lead
# instruments into neighbouring channels. Advanced users can still lower this
# through FGR_DEMUCS_SHIFTS on slower machines.
DEMUCS_SHIFTS = max(1, int(os.environ.get("FGR_DEMUCS_SHIFTS", "4")))
DEMUCS_OVERLAP = min(0.75, max(0.25, float(os.environ.get("FGR_DEMUCS_OVERLAP", "0.5"))))
STEM_NAMES = ["bass", "drums", "guitar", "piano", "vocals", "other"]
SUPPORTED_SOURCE_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aif", ".aiff"}
QUEUED_PROCESSING_STATES = {"queued", "retry"}
PROGRESS_PREFIX = "FGR_PROGRESS "

os.makedirs("samples", exist_ok=True)
log_f = open(LOG_FILE, "w", encoding="utf-8")

def log(msg):
    print(msg)
    log_f.write(msg + "\n")
    log_f.flush()

def emit_progress(percent, message, **detail):
    payload = {
        "state": "separating",
        "stage": "separation",
        "percent": round(max(5.0, min(71.5, float(percent))), 1),
        "message": str(message)[:240],
        "stageDetail": detail,
    }
    # The parent service consumes this machine-readable line while the plain
    # worker remains usable from a terminal.
    print(PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)

def remove_tree(path, attempts=6):
    """Remove a worker-only tree, retrying transient Windows file locks."""
    if not os.path.exists(path):
        return

    def onerror(_function, failing_path, _exc_info):
        try:
            os.chmod(failing_path, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass

    last_error = None
    for attempt in range(attempts):
        try:
            shutil.rmtree(path, onerror=onerror)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.1 * (attempt + 1))
    if last_error:
        raise last_error

def slugify(text):
    text = text.lower()
    replacements = {
        'č': 'c', 'ć': 'c', 'š': 's', 'đ': 'dj', 'ž': 'z',
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'dj', 'е': 'e', 'ж': 'z', 'з': 'z', 'и': 'i',
        'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r',
        'с': 's', 'т': 't', 'ћ': 'c', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'c', 'џ': 'dz', 'ш': 's'
    }
    for cyr, lat in replacements.items():
        text = text.replace(cyr, lat)
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    text = re.sub(r'[\s-]+', '-', text).strip('-')
    return text

def parse_mp3_filename(filename):
    name_without_ext = os.path.splitext(filename)[0]
    parts = [p.strip() for p in name_without_ext.split(" - ") if p.strip()]
    if len(parts) == 3:
        title = f"{parts[0]} - {parts[1]}"
        key = parts[2]
    elif len(parts) == 2:
        title = f"{parts[0]} - {parts[1]}"
        key = ""
    else:
        title = name_without_ext
        key = ""
    return title, key

def download_youtube_audio(video_url, song_id):
    log(f"Attempting to download YouTube audio for {song_id} from {video_url}...")
    output_filename = f"{song_id}.wav"

    if os.path.exists(output_filename):
        os.remove(output_filename)

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-x",
        "--audio-format", "wav",
        "-o", f"{song_id}.%(ext)s",
        video_url
    ]
    log(f"Running command: {' '.join(cmd)}")
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    log("yt-dlp stdout:")
    log(res.stdout)
    log("yt-dlp stderr:")
    log(res.stderr)

    if res.returncode != 0:
        raise Exception(f"yt-dlp download failed with code {res.returncode}")

    if not os.path.exists(output_filename):
        # yt-dlp/ffmpeg may choose a different extension on failure or fallback.
        temp_files = [
            f for f in os.listdir(".")
            if f.startswith(song_id) and os.path.splitext(f)[1].lower() in SUPPORTED_SOURCE_EXTENSIONS
        ]
        if temp_files:
            shutil.move(temp_files[0], output_filename)
        else:
            raise Exception("yt-dlp completed but output WAV file was not found.")

    log(f"Successfully downloaded YouTube audio to {output_filename}")
    return output_filename

def process_song_stems(song_id, local_audio):
    log(f"Starting 6-stem Demucs separation for {song_id} using source {local_audio}...")

    log("Cleaning up temp directories...")
    remove_tree("separated")

    try:
        # Run Demucs 6-stem model
        cmd = [
            sys.executable,
            "-m", "demucs",
            "-d", "cpu",
            "-n", DEMUCS_MODEL,
            "--shifts", str(DEMUCS_SHIFTS),
            "--overlap", str(DEMUCS_OVERLAP),
            # Keep the six stems on one common amplitude scale. Per-stem
            # rescaling changes their balance and prevents a neutral mixer
            # from reconstructing the uploaded master faithfully.
            "--float32",
            "--clip-mode", "none",
            local_audio
        ]
        log(f"Running command: {' '.join(cmd)}")
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        buffer = ""
        last_percent = -1
        pass_index = 0
        assert process.stdout is not None
        while True:
            character = process.stdout.read(1)
            if character == "":
                if process.poll() is not None:
                    break
                continue
            if character not in {"\r", "\n"}:
                buffer += character
                if len(buffer) < 8192:
                    continue
            line = buffer.strip()
            buffer = ""
            if not line:
                continue
            match = re.search(r"(?<!\d)(\d{1,3})%", line)
            if match:
                demucs_percent = min(100, int(match.group(1)))
                if demucs_percent + 40 < last_percent and pass_index < DEMUCS_SHIFTS - 1:
                    pass_index += 1
                    last_percent = -1
                if demucs_percent >= last_percent + 1:
                    last_percent = demucs_percent
                    overall_worker_percent = (
                        (pass_index + demucs_percent / 100.0) / DEMUCS_SHIFTS * 100.0
                    )
                    emit_progress(
                        5.0 + overall_worker_percent * 0.665,
                        f"Razdvajam 6 AI kanala: prolaz {pass_index + 1}/{DEMUCS_SHIFTS}, {demucs_percent}%",
                        worker="demucs",
                        workerPercent=round(overall_worker_percent, 1),
                        passPercent=demucs_percent,
                        passIndex=pass_index + 1,
                        passCount=DEMUCS_SHIFTS,
                        model=DEMUCS_MODEL,
                    )
            elif line:
                log("demucs: " + line)
        if buffer.strip():
            log("demucs: " + buffer.strip())
        return_code = process.wait()
        if return_code != 0:
            raise Exception(f"demucs exited with code {return_code}")

    except Exception as e:
        log(f"Demucs processing failed for {song_id}: {e}")
        return False, str(e)

    log("Preserving isolated stems as lossless float32 WAV...")
    output_dir = f"samples/{song_id}"
    os.makedirs(output_dir, exist_ok=True)

    try:
        # input name without extension for directory path matching
        input_name_clean = os.path.splitext(os.path.basename(local_audio))[0]

        for stem in STEM_NAMES:
            wav_path = f"separated/{DEMUCS_MODEL}/{input_name_clean}/{stem}.wav"
            output_path = f"{output_dir}/{stem}.wav"
            temporary_path = f"{output_path}.tmp"

            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"Stem file not found: {wav_path}")

            # Demucs already produced a common-scale float32 WAV. Copy those
            # exact samples instead of introducing a second, per-stem lossy MP3
            # encode that prevents the mixer from reconstructing the separated
            # result faithfully.
            try:
                shutil.copyfile(wav_path, temporary_path)
                os.replace(temporary_path, output_path)
            finally:
                if os.path.exists(temporary_path):
                    os.remove(temporary_path)
            legacy_mp3_path = f"{output_dir}/{stem}.mp3"
            if os.path.exists(legacy_mp3_path):
                os.remove(legacy_mp3_path)
            log(f"Saved lossless stem: {output_path}")

    except Exception as e:
        log(f"Lossless stem persistence failed for {song_id}: {e}")
        return False, str(e)
    finally:
        remove_tree("separated")

    log(f"Successfully processed 6 stems for {song_id}!")
    return True, ""

def set_processing(song, state, stage, message=""):
    song["processing"] = {
        "state": state,
        "stage": stage,
        "message": message,
        "updatedAt": datetime.now(timezone.utc).isoformat()
    }

def is_processing_requested(song):
    state = str((song.get("processing") or {}).get("state") or "").lower()
    return state in QUEUED_PROCESSING_STATES

def mark_ready(song):
    song["stems"] = True
    song["availableStems"] = STEM_NAMES
    song_id = str(song.get("id") or "").strip()
    if song_id:
        assets = song.get("assets")
        if not isinstance(assets, dict):
            assets = {}
            song["assets"] = assets
        assets["stems"] = {
            stem: {
                "url": f"samples/{song_id}/{stem}.wav",
                "contentType": "audio/wav",
            }
            for stem in STEM_NAMES
        }
    set_processing(song, "ready", "complete", "AI stemovi su spremni.")

def mark_failed(song, stage, message):
    song["stems"] = False
    set_processing(song, "failed", stage, message)

def process_queued_remote_songs(songs):
    modified = False
    for song in songs:
        if not (is_processing_requested(song) and (song.get("url") or song.get("videoId"))):
            continue

        song_id = song.get("id")
        youtube_url = song.get("url") or f"https://www.youtube.com/watch?v={song.get('videoId')}"
        log(f"Processing queued remote source for {song_id}: {youtube_url}")

        downloaded_file = None
        try:
            set_processing(song, "downloading", "source", "Preuzimam audio iz povezanog izvora.")
            downloaded_file = download_youtube_audio(youtube_url, song_id)
            set_processing(song, "separating", "separation", "Razdvajam AI stemove.")
            success, error = process_song_stems(song_id, downloaded_file)
            if success:
                mark_ready(song)
            else:
                mark_failed(song, "separation", error or "Demucs nije uspeo da obradi audio.")
            modified = True
        except Exception as e:
            log(f"Failed to process remote source for {song_id}: {e}")
            mark_failed(song, "source", str(e))
            modified = True
        finally:
            if downloaded_file and os.path.exists(downloaded_file):
                os.remove(downloaded_file)

    return modified

def main():
    log("Starting stem processing script...")
    if not os.path.exists(PLAYLISTS_DIR):
        log(f"Playlists directory not found: {PLAYLISTS_DIR}")
        return

    # Scan for uploaded local audio first. The source stays outside samples/ so it
    # never becomes part of the browser assets by accident.
    audio_files = [
        f for f in os.listdir(".")
        if os.path.isfile(f)
        and os.path.splitext(f)[1].lower() in SUPPORTED_SOURCE_EXTENSIONS
        and f != "temp_audio.mp3"
    ]

    playlist_files = [f for f in os.listdir(PLAYLISTS_DIR) if f.endswith(".json")]
    if not playlist_files:
        log("No playlists found.")
        return

    default_playlist_file = "feelgood.json" if "feelgood.json" in playlist_files else playlist_files[0]
    default_playlist_path = os.path.join(PLAYLISTS_DIR, default_playlist_file)

    with open(default_playlist_path, "r", encoding="utf-8") as f:
        try:
            active_playlist = json.load(f)
        except Exception as e:
            log(f"Failed to parse default playlist JSON {default_playlist_path}: {e}")
            return

    songs = active_playlist.setdefault("songs", [])
    playlist_modified = False

    # 1. Process uploaded local audio files.
    for audio_filename in audio_files:
        title, key = parse_mp3_filename(audio_filename)
        song_id = slugify(title)

        log(f"Processing uploaded file: {audio_filename}")
        log(f"Parsed Title: {title}, Key: {key}, ID: {song_id}")

        existing_song = next((s for s in songs if s.get("id") == song_id), None)
        if existing_song and existing_song.get("stems") is True:
            log(f"Song {song_id} already has stems. Skipping source file.")
            continue

        if existing_song:
            log(f"Song {song_id} already exists. Updating.")
            existing_song["key"] = key or existing_song.get("key", "")
            existing_song["stems"] = False
        else:
            log(f"Adding new song {song_id}.")
            new_song = {
                "id": song_id,
                "title": title,
                "key": key,
                "url": "",
                "videoId": "",
                "chords": [],
                "stems": False
            }
            songs.append(new_song)
            existing_song = new_song

        set_processing(existing_song, "separating", "separation", "Razdvajam AI stemove iz lokalnog audio fajla.")
        success, error = process_song_stems(song_id, audio_filename)
        if success:
            mark_ready(existing_song)
            playlist_modified = True
        else:
            mark_failed(existing_song, "separation", error or "Demucs nije uspeo da obradi audio.")
            playlist_modified = True

    # 2. Process explicitly queued remote sources in the default playlist.
    playlist_modified = process_queued_remote_songs(songs) or playlist_modified

    # Save playlist with final changes
    if playlist_modified or len(audio_files) > 0:
        log(f"Saving final playlist updates to {default_playlist_path}...")
        with open(default_playlist_path, "w", encoding="utf-8") as f:
            json.dump(active_playlist, f, ensure_ascii=False, indent=2)

    # Other playlists can have their own queued songs even though uploaded local
    # files still use the default playlist for backwards compatibility.
    for playlist_file in playlist_files:
        if playlist_file == default_playlist_file:
            continue
        playlist_path = os.path.join(PLAYLISTS_DIR, playlist_file)
        try:
            with open(playlist_path, "r", encoding="utf-8") as f:
                playlist = json.load(f)
            playlist_songs = playlist.setdefault("songs", [])
            if process_queued_remote_songs(playlist_songs):
                log(f"Saving processed queue to {playlist_path}...")
                with open(playlist_path, "w", encoding="utf-8") as f:
                    json.dump(playlist, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"Failed to process playlist queue in {playlist_path}: {e}")

    log("Main processing finished.")
    log_f.close()

if __name__ == "__main__":
    main()

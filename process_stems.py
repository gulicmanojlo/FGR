import os
import subprocess
import json
import shutil
import re
from datetime import datetime, timezone

PLAYLISTS_DIR = "playlists"
LOG_FILE = "samples/stems_log.txt"
DEMUCS_MODEL = "htdemucs_6s"
STEM_NAMES = ["bass", "drums", "guitar", "piano", "vocals", "other"]
SUPPORTED_SOURCE_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".webm"}
QUEUED_PROCESSING_STATES = {"queued", "retry"}

os.makedirs("samples", exist_ok=True)
log_f = open(LOG_FILE, "w", encoding="utf-8")

def log(msg):
    print(msg)
    log_f.write(msg + "\n")
    log_f.flush()

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
            raise Exception("yt-dlp completed but output MP3 file not found.")

    log(f"Successfully downloaded YouTube audio to {output_filename}")
    return output_filename

def process_song_stems(song_id, local_audio):
    log(f"Starting 6-stem Demucs separation for {song_id} using source {local_audio}...")

    log("Cleaning up temp directories...")
    if os.path.exists("separated"):
        shutil.rmtree("separated")

    try:
        # Run Demucs 6-stem model
        cmd = [
            "demucs",
            "-d", "cpu",
            "-n", DEMUCS_MODEL,
            local_audio
        ]
        log(f"Running command: {' '.join(cmd)}")
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        log("demucs stdout:")
        log(res.stdout)
        log("demucs stderr:")
        log(res.stderr)

        if res.returncode != 0:
            raise Exception(f"demucs exited with code {res.returncode}")

    except Exception as e:
        log(f"Demucs processing failed for {song_id}: {e}")
        return False, str(e)

    log("Converting isolated stems to browser-ready MP3 (320kbps)...")
    output_dir = f"samples/{song_id}"
    os.makedirs(output_dir, exist_ok=True)

    try:
        # input name without extension for directory path matching
        input_name_clean = os.path.splitext(os.path.basename(local_audio))[0]

        for stem in STEM_NAMES:
            wav_path = f"separated/{DEMUCS_MODEL}/{input_name_clean}/{stem}.wav"
            mp3_path = f"{output_dir}/{stem}.mp3"

            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"Stem file not found: {wav_path}")

            cmd = [
                "ffmpeg",
                "-y",
                "-i", wav_path,
                "-c:a", "libmp3lame",
                "-b:a", "320k",
                "-map_metadata", "-1",
                mp3_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if res.returncode != 0:
                raise Exception(f"ffmpeg exited with code {res.returncode} for stem {stem}")
            log(f"Saved stem: {mp3_path}")

    except Exception as e:
        log(f"FFmpeg conversion failed for {song_id}: {e}")
        return False, str(e)
    finally:
        if os.path.exists("separated"):
            shutil.rmtree("separated")

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

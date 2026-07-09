import os
import subprocess
import json
import shutil
import re

PLAYLISTS_DIR = "playlists"
LOG_FILE = "samples/stems_log.txt"

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
    name_without_ext = filename[:-4]
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
    output_filename = f"{song_id}.mp3"

    if os.path.exists(output_filename):
        os.remove(output_filename)

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
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
        # In case it downloaded as something else, check if any mp3 matches
        temp_files = [f for f in os.listdir(".") if f.startswith(song_id) and f.endswith(".mp3")]
        if temp_files:
            shutil.move(temp_files[0], output_filename)
        else:
            raise Exception("yt-dlp completed but output MP3 file not found.")

    log(f"Successfully downloaded YouTube audio to {output_filename}")
    return output_filename

def process_song_stems(song_id, local_mp3):
    log(f"Starting 6-stem Demucs separation for {song_id} using source {local_mp3}...")

    log("Cleaning up temp directories...")
    if os.path.exists("separated"):
        shutil.rmtree("separated")

    try:
        # Run Demucs 6-stem model
        cmd = [
            "demucs",
            "-d", "cpu",
            "-n", "htdemucs_6",
            local_mp3
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
        return False

    log("Converting isolated stems to high-quality MP3 (256kbps)...")
    stems = ["bass", "drums", "guitar", "piano", "vocals", "other"]
    output_dir = f"samples/{song_id}"
    os.makedirs(output_dir, exist_ok=True)

    try:
        # input name without extension for directory path matching
        input_name_clean = os.path.splitext(local_mp3)[0]

        for stem in stems:
            wav_path = f"separated/htdemucs_6/{input_name_clean}/{stem}.wav"
            mp3_path = f"{output_dir}/{stem}.mp3"

            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"Stem file not found: {wav_path}")

            cmd = [
                "ffmpeg",
                "-y",
                "-i", wav_path,
                "-ab", "256k",
                mp3_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if res.returncode != 0:
                raise Exception(f"ffmpeg exited with code {res.returncode} for stem {stem}")
            log(f"Saved stem: {mp3_path}")

        # Clean up source file
        if os.path.exists(local_mp3):
            os.remove(local_mp3)
            log(f"Deleted source file: {local_mp3}")

    except Exception as e:
        log(f"FFmpeg conversion failed for {song_id}: {e}")
        return False
    finally:
        if os.path.exists("separated"):
            shutil.rmtree("separated")

    log(f"Successfully processed 6 stems for {song_id}!")
    return True

def main():
    log("Starting stem processing script...")
    if not os.path.exists(PLAYLISTS_DIR):
        log(f"Playlists directory not found: {PLAYLISTS_DIR}")
        return

    # Scan for any uploaded local MP3 files first
    mp3_files = [f for f in os.listdir(".") if f.endswith(".mp3") and f != "temp_audio.mp3"]

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

    # 1. Process uploaded local MP3s
    for mp3_filename in mp3_files:
        title, key = parse_mp3_filename(mp3_filename)
        song_id = slugify(title)

        log(f"Processing uploaded file: {mp3_filename}")
        log(f"Parsed Title: {title}, Key: {key}, ID: {song_id}")

        existing_song = next((s for s in songs if s.get("id") == song_id), None)
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

        with open(default_playlist_path, "w", encoding="utf-8") as f:
            json.dump(active_playlist, f, ensure_ascii=False, indent=2)

        clean_local_mp3 = f"{song_id}.mp3"
        shutil.move(mp3_filename, clean_local_mp3)

        success = process_song_stems(song_id, clean_local_mp3)
        if success:
            existing_song["stems"] = True
            playlist_modified = True
        else:
            if os.path.exists(clean_local_mp3):
                shutil.move(clean_local_mp3, mp3_filename)

    # 2. Check playlist songs with stems=False and try to download them from YouTube if they have a URL
    for song in songs:
        if song.get("stems") is False and (song.get("url") or song.get("videoId")):
            song_id = song.get("id")
            youtube_url = song.get("url") or f"https://www.youtube.com/watch?v={song.get('videoId')}"
            log(f"Playlist song {song_id} is marked stems=False and has a YouTube link: {youtube_url}")

            try:
                downloaded_file = download_youtube_audio(youtube_url, song_id)
                success = process_song_stems(song_id, downloaded_file)
                if success:
                    song["stems"] = True
                    playlist_modified = True
            except Exception as e:
                log(f"Failed to process YouTube download/separation for {song_id}: {e}")
                # We do not crash the script, we just skip it so other files can continue
                continue

    # Save playlist with final changes
    if playlist_modified or len(mp3_files) > 0:
        log(f"Saving final playlist updates to {default_playlist_path}...")
        with open(default_playlist_path, "w", encoding="utf-8") as f:
            json.dump(active_playlist, f, ensure_ascii=False, indent=2)

    log("Main processing finished.")
    log_f.close()

if __name__ == "__main__":
    main()

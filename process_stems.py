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
    # Replace common Serbian characters
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
    # Remove extension
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

def process_song_stems(song_id, local_mp3):
    log(f"Found local file {local_mp3}. Starting separation...")

    # 2. Run Demucs
    log("Running Demucs stem separation...")
    if os.path.exists("separated"):
        shutil.rmtree("separated")
        
    try:
        cmd = [
            "demucs",
            "-d", "cpu",
            "-n", "htdemucs",
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

    # 3. Convert Wav stems to Mp3 and save in samples/
    log("Converting stems to MP3...")
    stems = ["bass", "vocals", "drums", "other"]
    output_dir = f"samples/{song_id}"
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        for stem in stems:
            # Output goes to separated/htdemucs/{song_id_without_ext} where song_id_without_ext matches input filename without extension
            input_name_clean = os.path.splitext(local_mp3)[0]
            wav_path = f"separated/htdemucs/{input_name_clean}/{stem}.wav"
            mp3_path = f"{output_dir}/{stem}.mp3"
            
            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"Stem file not found: {wav_path}")
                
            cmd = [
                "ffmpeg",
                "-y",
                "-i", wav_path,
                "-ab", "128k",
                mp3_path
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if res.returncode != 0:
                raise Exception(f"ffmpeg exited with code {res.returncode}")
            log(f"Saved stem: {mp3_path}")
            
        # Clean up source file
        os.remove(local_mp3)
        log(f"Deleted source file: {local_mp3}")
        
    except Exception as e:
        log(f"FFmpeg conversion failed for {song_id}: {e}")
        return False
    finally:
        # Cleanup temp directory
        if os.path.exists("separated"):
            shutil.rmtree("separated")
            
    log(f"Successfully processed stems for {song_id}!")
    return True

def main():
    log("Starting stem processing script...")
    if not os.path.exists(PLAYLISTS_DIR):
        log(f"Playlists directory not found: {PLAYLISTS_DIR}")
        return

    # 1. Scan for any uploaded MP3 files in root
    mp3_files = [f for f in os.listdir(".") if f.endswith(".mp3") and f != "temp_audio.mp3"]
    
    playlist_files = [f for f in os.listdir(PLAYLISTS_DIR) if f.endswith(".json")]
    if not playlist_files:
        log("No playlists found to update.")
        return
        
    # We will default to updating the first playlist found (or feelgood.json if it exists)
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

    # Process each uploaded local MP3
    for mp3_filename in mp3_files:
        title, key = parse_mp3_filename(mp3_filename)
        song_id = slugify(title)
        
        log(f"Processing uploaded file: {mp3_filename}")
        log(f"Parsed Title: {title}, Key: {key}, ID: {song_id}")
        
        # Check if song already exists in playlist
        existing_song = next((s for s in songs if s.get("id") == song_id), None)
        
        if existing_song:
            log(f"Song {song_id} already exists in playlist. Updating.")
            existing_song["key"] = key or existing_song.get("key", "")
            existing_song["stems"] = False # Mark for processing
        else:
            log(f"Adding new song {song_id} to playlist.")
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

        # Save playlist to apply new song so demucs has it registered
        with open(default_playlist_path, "w", encoding="utf-8") as f:
            json.dump(active_playlist, f, ensure_ascii=False, indent=2)

        # Rename to clean {song_id}.mp3 locally before Demucs to avoid path/naming issues with spaces
        clean_local_mp3 = f"{song_id}.mp3"
        shutil.move(mp3_filename, clean_local_mp3)
        
        success = process_song_stems(song_id, clean_local_mp3)
        if success:
            existing_song["stems"] = True
            playlist_modified = True
        else:
            # If failed, restore the original filename so it can be re-attempted
            if os.path.exists(clean_local_mp3):
                shutil.move(clean_local_mp3, mp3_filename)

    # Save playlist with final stems: true statuses
    if playlist_modified or len(mp3_files) > 0:
        log(f"Saving final playlist updates to {default_playlist_path}...")
        with open(default_playlist_path, "w", encoding="utf-8") as f:
            json.dump(active_playlist, f, ensure_ascii=False, indent=2)
            
    # Fallback/Legacy scan for any songs that were marked stems: false but have no mp3 in root
    # (e.g. if the push had a playlist update but no MP3, we check if they exist or we skip)
    for filename in playlist_files:
        filepath = os.path.join(PLAYLISTS_DIR, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            try:
                pl = json.load(f)
            except:
                continue
                
            pl_modified = False
            for song in pl.get("songs", []):
                s_id = song.get("id")
                # If song has stems = False, check if there is an {s_id}.mp3 in root
                if song.get("stems") is False:
                    clean_local_mp3 = f"{s_id}.mp3"
                    if os.path.exists(clean_local_mp3):
                        success = process_song_stems(s_id, clean_local_mp3)
                        if success:
                            song["stems"] = True
                            pl_modified = True
            
            if pl_modified:
                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(pl, f, ensure_ascii=False, indent=2)

    log("Main processing finished.")
    log_f.close()

if __name__ == "__main__":
    main()

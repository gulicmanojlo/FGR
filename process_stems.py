import os
import subprocess
import json
import shutil
import sys

PLAYLISTS_DIR = "playlists"
LOG_FILE = "samples/stems_log.txt"

os.makedirs("samples", exist_ok=True)
log_f = open(LOG_FILE, "w", encoding="utf-8")

def log(msg):
    print(msg)
    log_f.write(msg + "\n")
    log_f.flush()

def process_song(song):
    song_id = song.get("id")
    if not song_id:
        log(f"Skipping song due to missing ID: {song}")
        return False

    # Check if the local MP3 file exists in the root directory
    local_mp3 = f"{song_id}.mp3"
    if not os.path.exists(local_mp3):
        # The file isn't present to be processed yet, which is normal
        log(f"No local file {local_mp3} found in root. Skipping.")
        return False

    log(f"--- Processing song: {song.get('title')} ({song_id}) ---")
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
            # Input file was '{song_id}.mp3', so demucs outputs to separated/htdemucs/{song_id}/
            wav_path = f"separated/htdemucs/{song_id}/{stem}.wav"
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
            
        # Remove the uploaded raw MP3 from the root
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

    playlist_files = [f for f in os.listdir(PLAYLISTS_DIR) if f.endswith(".json")]
    
    modified = False
    for filename in playlist_files:
        filepath = os.path.join(PLAYLISTS_DIR, filename)
        log(f"Scanning playlist: {filepath}")
        
        with open(filepath, "r", encoding="utf-8") as f:
            try:
                playlist = json.load(f)
            except Exception as e:
                log(f"Failed to parse playlist JSON {filepath}: {e}")
                continue

        songs = playlist.get("songs", [])
        playlist_modified = False
        for song in songs:
            if not song.get("stems"):
                success = process_song(song)
                if success:
                    song["stems"] = True
                    playlist_modified = True
                    modified = True

        if playlist_modified:
            log(f"Saving updated playlist: {filepath}")
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(playlist, f, ensure_ascii=False, indent=2)
                
    log("Main processing finished.")
    log_f.close()

if __name__ == "__main__":
    main()

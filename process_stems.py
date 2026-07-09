import os
import subprocess
import json
import shutil

PLAYLISTS_DIR = "playlists"

def process_song(song):
    song_id = song.get("id")
    video_id = song.get("videoId")
    if not song_id or not video_id:
        print(f"Skipping song due to missing metadata: {song}")
        return False

    print(f"--- Processing song: {song.get('title')} ({song_id}) ---")
    url = f"https://www.youtube.com/watch?v={video_id}"
    
    # 1. Download YouTube audio
    print(f"Downloading audio from {url}...")
    temp_mp3 = "temp_audio.mp3"
    if os.path.exists(temp_mp3):
        os.remove(temp_mp3)
        
    try:
        subprocess.run([
            "yt-dlp",
            "-x",
            "--audio-format",
            "mp3",
            "-o",
            temp_mp3,
            url
        ], check=True)
    except Exception as e:
        print(f"Failed to download audio for {song_id}: {e}")
        return False

    # 2. Run Demucs
    print("Running Demucs stem separation...")
    if os.path.exists("separated"):
        shutil.rmtree("separated")
        
    try:
        subprocess.run([
            "demucs",
            "-d", "cpu",
            "-n", "htdemucs",
            temp_mp3
        ], check=True)
    except Exception as e:
        print(f"Demucs processing failed for {song_id}: {e}")
        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        return False

    # 3. Convert Wav stems to Mp3 and save in samples/
    print("Converting stems to MP3...")
    stems = ["bass", "vocals", "drums", "other"]
    output_dir = f"samples/{song_id}"
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        for stem in stems:
            wav_path = f"separated/htdemucs/temp_audio/{stem}.wav"
            mp3_path = f"{output_dir}/{stem}.mp3"
            
            # If demucs finishes, wav_path must exist
            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"Stem file not found: {wav_path}")
                
            subprocess.run([
                "ffmpeg",
                "-y",
                "-i", wav_path,
                "-ab", "128k",
                mp3_path
            ], check=True)
            print(f"Saved stem: {mp3_path}")
    except Exception as e:
        print(f"FFmpeg conversion failed for {song_id}: {e}")
        return False
    finally:
        # Cleanup temp directories
        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        if os.path.exists("separated"):
            shutil.rmtree("separated")
            
    print(f"Successfully processed stems for {song_id}!")
    return True

def main():
    if not os.path.exists(PLAYLISTS_DIR):
        print(f"Playlists directory not found: {PLAYLISTS_DIR}")
        return

    playlist_files = [f for f in os.listdir(PLAYLISTS_DIR) if f.endswith(".json")]
    
    for filename in playlist_files:
        filepath = os.path.join(PLAYLISTS_DIR, filename)
        print(f"Scanning playlist: {filepath}")
        
        with open(filepath, "r", encoding="utf-8") as f:
            try:
                playlist = json.load(f)
            except Exception as e:
                print(f"Failed to parse playlist JSON {filepath}: {e}")
                continue

        songs = playlist.get("songs", [])
        modified = False
        for song in songs:
            # Process if 'stems' flag is not True
            if not song.get("stems"):
                success = process_song(song)
                if success:
                    song["stems"] = True
                    modified = True

        if modified:
            print(f"Saving updated playlist: {filepath}")
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(playlist, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()

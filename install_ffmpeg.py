import os
import sys
import urllib.request
import zipfile
import shutil

URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
DEST_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG_DIR = os.path.join(DEST_DIR, "ffmpeg")

def download_file(url, filepath):
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urllib.request.urlopen(req) as response, open(filepath, 'wb') as out_file:
        total_size = int(response.info().get('Content-Length', 0))
        read_so_far = 0
        block_size = 1024 * 1024 # 1MB
        while True:
            buffer = response.read(block_size)
            if not buffer:
                break
            read_so_far += len(buffer)
            out_file.write(buffer)
            if total_size > 0:
                percent = min(100, read_so_far * 100 // total_size)
                sys.stdout.write(f"\rDownloading FFmpeg: {percent}% ({read_so_far // (1024*1024)}MB / {total_size // (1024*1024)}MB)")
            else:
                sys.stdout.write(f"\rDownloading FFmpeg: {read_so_far // (1024*1024)}MB...")
            sys.stdout.flush()

def main():
    if os.path.exists(os.path.join(FFMPEG_DIR, "bin", "ffmpeg.exe")):
        print("FFmpeg is already installed locally.")
        return

    print("Downloading FFmpeg from GitHub (BtbN builds)...")
    zip_path = os.path.join(DEST_DIR, "ffmpeg.zip")
    try:
        download_file(URL, zip_path)
        print("\nDownload complete. Extracting files...")
    except Exception as e:
        print(f"\nFailed to download FFmpeg: {e}")
        return

    temp_extract_dir = os.path.join(DEST_DIR, "temp_ffmpeg_extract")
    try:
        if os.path.exists(temp_extract_dir):
            shutil.rmtree(temp_extract_dir)
        os.makedirs(temp_extract_dir)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_extract_dir)

        extracted_folders = os.listdir(temp_extract_dir)
        if not extracted_folders:
            print("Error: Extracted archive is empty.")
            return
        
        src_folder = os.path.join(temp_extract_dir, extracted_folders[0])
        
        if os.path.exists(FFMPEG_DIR):
            shutil.rmtree(FFMPEG_DIR)
            
        shutil.move(src_folder, FFMPEG_DIR)
        print("FFmpeg installed successfully.")

    except Exception as e:
        print(f"Failed to extract FFmpeg: {e}")
    finally:
        # Clean up
        if os.path.exists(zip_path):
            try:
                os.remove(zip_path)
            except Exception:
                pass
        if os.path.exists(temp_extract_dir):
            try:
                shutil.rmtree(temp_extract_dir)
            except Exception:
                pass

if __name__ == "__main__":
    main()

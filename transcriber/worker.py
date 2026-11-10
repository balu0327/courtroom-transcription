"""Whisper transcription worker for CourtScribe.

A long-running process driven by the Node server over stdin/stdout, one JSON
object per line. Keeping the model loaded makes each live chunk fast.

Request:  {"id": 7, "bytes": 320000, "language": "en", "prompt": "...", "partial": false}
          followed by exactly `bytes` bytes of raw 16 kHz mono int16 PCM
Replies:  {"type": "ready", "model": "...", "device": "cuda", "compute": "float16"}
          {"id": 7, "type": "segment", "start": 1.2, "end": 3.4, "text": "...",
           "avg_logprob": -0.2, "no_speech_prob": 0.01,
           "words": [{"start": 1.2, "end": 1.5, "word": " Good", "p": 0.98}, ...]}
          {"id": 7, "type": "done", "seconds": 0.41}
          {"id": 7, "type": "error", "message": "..."}
Logs go to stderr.
"""
import glob
import json
import os
import sys
import time

RATE = 16000


def log(*args):
    print("[whisper]", *args, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def add_cuda_dll_dirs():
    """pip's nvidia-cublas/cudnn wheels put DLLs in site-packages/nvidia/*/bin;
    Windows will not find them unless we register those directories."""
    if os.name != "nt":
        return
    for base in sys.path:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass


def load_model():
    from faster_whisper import WhisperModel

    models_dir = os.environ.get("WHISPER_MODELS_DIR")
    wanted = os.environ.get("WHISPER_MODEL", "")
    device_pref = os.environ.get("WHISPER_DEVICE", "auto")

    attempts = []
    if device_pref in ("auto", "cuda"):
        attempts.append(("cuda", "float16", wanted or "large-v3-turbo"))
    if device_pref in ("auto", "cpu"):
        attempts.append(("cpu", "int8", wanted or "small.en"))

    last = None
    for device, compute, name in attempts:
        try:
            log(f"loading {name} on {device} ({compute})...")
            t = time.time()
            model = WhisperModel(name, device=device, compute_type=compute, download_root=models_dir)
            # Run a tiny inference so missing CUDA libraries fail here, not mid-hearing.
            import numpy as np
            list(model.transcribe(np.zeros(RATE, dtype=np.float32), language="en")[0])
            log(f"loaded in {time.time() - t:.1f}s")
            return model, name, device, compute
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"could not use {device}: {e}")
    raise RuntimeError(f"no usable Whisper configuration: {last}")


def read_exact(stream, n):
    chunks = []
    while n > 0:
        chunk = stream.read(n)
        if not chunk:
            raise EOFError("stdin closed mid-request")
        chunks.append(chunk)
        n -= len(chunk)
    return b"".join(chunks)


def handle(model, req, raw):
    import numpy as np

    t = time.time()
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size < RATE // 4:
        send({"id": req["id"], "type": "done", "seconds": 0})
        return
    partial = bool(req.get("partial"))
    segments, _info = model.transcribe(
        audio,
        language=req.get("language") or None,
        initial_prompt=req.get("prompt") or None,
        beam_size=1 if partial else 5,
        word_timestamps=not partial,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        temperature=0.0 if partial else [0.0, 0.2, 0.4],
    )
    for s in segments:
        words = [
            {"start": w.start, "end": w.end, "word": w.word, "p": w.probability}
            for w in (s.words or [])
        ]
        send({
            "id": req["id"], "type": "segment",
            "start": s.start, "end": s.end, "text": s.text.strip(),
            "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob,
            "words": words,
        })
    send({"id": req["id"], "type": "done", "seconds": round(time.time() - t, 3)})


def main():
    add_cuda_dll_dirs()
    try:
        model, name, device, compute = load_model()
    except Exception as e:  # noqa: BLE001
        send({"type": "fatal", "message": str(e)})
        sys.exit(1)
    send({"type": "ready", "model": name, "device": device, "compute": compute})

    # Audio arrives inline: a JSON header line, then exactly `bytes` bytes of
    # PCM. (No file paths: Microsoft Store Python runs sandboxed and may not
    # see files other processes create under AppData.)
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            raw = read_exact(stdin, int(req.get("bytes", 0)))
        except (json.JSONDecodeError, ValueError):
            continue
        try:
            handle(model, req, raw)
        except Exception as e:  # noqa: BLE001
            log("job failed:", e)
            send({"id": req.get("id"), "type": "error", "message": str(e)})


if __name__ == "__main__":
    main()
